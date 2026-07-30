#!/usr/bin/env python
"""SpaceMouse Raw Input bridge for the flow animation editor.

The browser cannot read 3Dconnexion HID devices directly from a local app
window, so this small Windows helper translates Raw Input reports into a
localhost WebSocket stream consumed by app.js.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import socketserver
import struct
import threading
import time


HOST = "127.0.0.1"
PORT = 8766

USER32 = ctypes.WinDLL("user32", use_last_error=True)

if not hasattr(wintypes, "LRESULT"):
    wintypes.LRESULT = ctypes.c_ssize_t

WPARAM_T = ctypes.c_size_t
LPARAM_T = ctypes.c_ssize_t
LRESULT_T = ctypes.c_ssize_t

WM_INPUT = 0x00FF
WM_DESTROY = 0x0002
RID_INPUT = 0x10000003
RIM_TYPEHID = 2
RIDEV_INPUTSINK = 0x00000100


class RAWINPUTDEVICE(ctypes.Structure):
    _fields_ = [
        ("usUsagePage", wintypes.USHORT),
        ("usUsage", wintypes.USHORT),
        ("dwFlags", wintypes.DWORD),
        ("hwndTarget", wintypes.HWND),
    ]


class RAWINPUTHEADER(ctypes.Structure):
    _fields_ = [
        ("dwType", wintypes.DWORD),
        ("dwSize", wintypes.DWORD),
        ("hDevice", wintypes.HANDLE),
        ("wParam", wintypes.WPARAM),
    ]


class RAWHID(ctypes.Structure):
    _fields_ = [
        ("dwSizeHid", wintypes.DWORD),
        ("dwCount", wintypes.DWORD),
        ("bRawData", ctypes.c_ubyte * 1),
    ]


class RAWINPUTDATA(ctypes.Union):
    _fields_ = [("hid", RAWHID)]


class RAWINPUT(ctypes.Structure):
    _fields_ = [
        ("header", RAWINPUTHEADER),
        ("data", RAWINPUTDATA),
    ]


class WNDCLASS(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HCURSOR),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


WNDPROC = ctypes.WINFUNCTYPE(LRESULT_T, wintypes.HWND, wintypes.UINT, WPARAM_T, LPARAM_T)

USER32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM_T, LPARAM_T]
USER32.DefWindowProcW.restype = LRESULT_T
USER32.CreateWindowExW.restype = wintypes.HWND
USER32.RegisterRawInputDevices.argtypes = [
    ctypes.POINTER(RAWINPUTDEVICE),
    wintypes.UINT,
    wintypes.UINT,
]
USER32.RegisterRawInputDevices.restype = wintypes.BOOL
USER32.GetRawInputData.argtypes = [
    wintypes.HANDLE,
    wintypes.UINT,
    wintypes.LPVOID,
    ctypes.POINTER(wintypes.UINT),
    wintypes.UINT,
]
USER32.GetRawInputData.restype = wintypes.UINT


def int16_le(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], "little", signed=True)


def get_raw_hid(lparam: wintypes.LPARAM) -> bytes | None:
    size = wintypes.UINT(0)
    header_size = ctypes.sizeof(RAWINPUTHEADER)
    USER32.GetRawInputData(lparam, RID_INPUT, None, ctypes.byref(size), header_size)
    if not size.value:
        return None

    buf = ctypes.create_string_buffer(size.value)
    got = USER32.GetRawInputData(lparam, RID_INPUT, buf, ctypes.byref(size), header_size)
    if got == 0xFFFFFFFF:
        return None

    raw = ctypes.cast(buf, ctypes.POINTER(RAWINPUT)).contents
    if raw.header.dwType != RIM_TYPEHID:
        return None

    base = ctypes.sizeof(RAWINPUTHEADER) + 2 * ctypes.sizeof(wintypes.DWORD)
    total = raw.data.hid.dwSizeHid * raw.data.hid.dwCount
    return bytes(buf.raw[base : base + total])


def parse_axis_report(data: bytes) -> tuple[int, tuple[int, int, int], tuple[int, int, int] | None] | None:
    if len(data) >= 13 and data[0] == 1:
        return (
            1,
            (int16_le(data, 1), int16_le(data, 3), int16_le(data, 5)),
            (int16_le(data, 7), int16_le(data, 9), int16_le(data, 11)),
        )
    if len(data) >= 7 and data[0] in (1, 2):
        return data[0], (int16_le(data, 1), int16_le(data, 3), int16_le(data, 5)), None
    if len(data) == 6:
        return 1, (int16_le(data, 0), int16_le(data, 2), int16_le(data, 4)), None
    return None


class WebSocketHub:
    def __init__(self, *, verbose: bool = False) -> None:
        self.clients: set[socketserver.BaseRequestHandler] = set()
        self.lock = threading.Lock()
        self.verbose = verbose

    def add(self, handler: socketserver.BaseRequestHandler) -> None:
        with self.lock:
            self.clients.add(handler)
        if self.verbose:
            print("client connected", flush=True)

    def remove(self, handler: socketserver.BaseRequestHandler) -> None:
        with self.lock:
            self.clients.discard(handler)
        if self.verbose:
            print("client disconnected", flush=True)

    def broadcast(self, payload: dict[str, int | float]) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        frame = self.frame(data)
        stale = []
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.request.sendall(frame)
            except OSError:
                stale.append(client)
        for client in stale:
            self.remove(client)

    @staticmethod
    def frame(data: bytes) -> bytes:
        if len(data) < 126:
            header = bytes([0x81, len(data)])
        elif len(data) < 65536:
            header = bytes([0x81, 126]) + struct.pack("!H", len(data))
        else:
            header = bytes([0x81, 127]) + struct.pack("!Q", len(data))
        return header + data


class WebSocketHandler(socketserver.BaseRequestHandler):
    hub: WebSocketHub

    def handle(self) -> None:
        try:
            request = self.request.recv(4096).decode("utf-8", "ignore")
            headers = {}
            for line in request.splitlines()[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            key = headers.get("sec-websocket-key")
            if not key:
                return
            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
            ).decode("ascii")
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            self.request.sendall(response.encode("ascii"))
            self.hub.add(self)
            while True:
                data = self.request.recv(2)
                if not data:
                    break
                opcode = data[0] & 0x0F
                length = data[1] & 0x7F
                if length == 126:
                    length = struct.unpack("!H", self.request.recv(2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", self.request.recv(8))[0]
                masked = data[1] & 0x80
                mask = self.request.recv(4) if masked else b""
                payload = self.request.recv(length) if length else b""
                if masked and payload:
                    payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
                if opcode == 0x8:
                    break
        finally:
            self.hub.remove(self)


class ThreadingWebSocketServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class SpaceMouseBridge:
    def __init__(self, hub: WebSocketHub, *, threshold: int, interval: float, verbose: bool) -> None:
        self.hub = hub
        self.threshold = threshold
        self.interval = interval
        self.verbose = verbose
        self.translation = (0, 0, 0)
        self.rotation = (0, 0, 0)
        self.last_sent_at = 0.0
        self.wndproc = WNDPROC(self._wndproc)

    def start(self) -> None:
        class_name = "FlowAnimationSpaceMouseBridge"
        wc = WNDCLASS()
        wc.lpfnWndProc = ctypes.cast(self.wndproc, ctypes.c_void_p).value
        wc.lpszClassName = class_name
        atom = USER32.RegisterClassW(ctypes.byref(wc))
        if not atom:
            raise ctypes.WinError(ctypes.get_last_error(), "RegisterClassW")
        hwnd = USER32.CreateWindowExW(0, class_name, class_name, 0, 0, 0, 0, 0, None, None, None, None)
        if not hwnd:
            raise ctypes.WinError(ctypes.get_last_error(), "CreateWindowExW")
        rid = RAWINPUTDEVICE(0x01, 0x08, RIDEV_INPUTSINK, hwnd)
        if not USER32.RegisterRawInputDevices(ctypes.byref(rid), 1, ctypes.sizeof(rid)):
            raise ctypes.WinError(ctypes.get_last_error(), "RegisterRawInputDevices")
        if self.verbose:
            print(f"SpaceMouse bridge listening on ws://{HOST}:{PORT}", flush=True)
        msg = wintypes.MSG()
        while USER32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            USER32.TranslateMessage(ctypes.byref(msg))
            USER32.DispatchMessageW(ctypes.byref(msg))

    def _wndproc(self, hwnd: wintypes.HWND, msg: int, wparam: WPARAM_T, lparam: LPARAM_T) -> int:
        if msg == WM_INPUT:
            data = get_raw_hid(lparam)
            if data:
                self._handle_hid(data)
        elif msg == WM_DESTROY:
            USER32.PostQuitMessage(0)
        return USER32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _handle_hid(self, data: bytes) -> None:
        parsed = parse_axis_report(data)
        if not parsed:
            return
        report_id, values, combined_rotation = parsed
        if report_id == 1:
            self.translation = values
            if combined_rotation is not None:
                self.rotation = combined_rotation
        elif report_id == 2:
            self.rotation = values
        now = time.perf_counter()
        if now - self.last_sent_at < self.interval:
            return
        axes = {
            "x": self._deadzone(self.translation[0]),
            "y": self._deadzone(self.translation[1]),
            "z": self._deadzone(self.translation[2]),
            "rx": self._deadzone(self.rotation[0]),
            "ry": self._deadzone(self.rotation[1]),
            "rz": self._deadzone(self.rotation[2]),
            "ts": time.time(),
        }
        self.last_sent_at = now
        self.hub.broadcast(axes)
        if self.verbose:
            print(axes, flush=True)

    def _deadzone(self, value: int) -> int:
        return 0 if abs(value) < self.threshold else value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--threshold", type=int, default=18)
    parser.add_argument("--interval", type=float, default=1 / 60)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    hub = WebSocketHub(verbose=args.verbose)
    WebSocketHandler.hub = hub
    server = ThreadingWebSocketServer((HOST, args.port), WebSocketHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    SpaceMouseBridge(hub, threshold=args.threshold, interval=args.interval, verbose=args.verbose).start()


if __name__ == "__main__":
    main()
