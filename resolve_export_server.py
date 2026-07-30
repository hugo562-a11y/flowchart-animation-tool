from __future__ import annotations

import shutil
import subprocess
import tempfile
import zipfile
import json
import os
from email.parser import BytesParser
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 8765
ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/frame-export":
            self._frame_export(parsed)
            return
        if parsed.path == "/api/transcribe-audio":
            self._transcribe_audio(parsed)
            return
        if parsed.path == "/api/convert-audio":
            self._convert_audio(parsed)
            return
        if parsed.path != "/api/resolve-export":
            self.send_error(404)
            return

        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.send_error(500, "ffmpeg is not available")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "invalid content length")
            return
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_error(413, "invalid upload size")
            return

        query = parse_qs(parsed.query)
        try:
            fps = max(1, min(60, int(query.get("fps", ["30"])[0])))
        except ValueError:
            fps = 30

        with tempfile.TemporaryDirectory(prefix="flow-animation-") as temp:
            source = Path(temp) / "browser-recording"
            output = Path(temp) / "flow-animation-resolve.mov"
            source.write_bytes(self.rfile.read(length))
            command = [
                ffmpeg,
                "-y",
                "-i",
                str(source),
                "-an",
                "-vf",
                f"fps={fps},format=yuv422p10le",
                "-c:v",
                "prores_ks",
                "-profile:v",
                "3",
                "-vendor",
                "apl0",
                str(output),
            ]
            result = subprocess.run(command, capture_output=True, text=True, timeout=300)
            if result.returncode != 0 or not output.exists():
                self.send_error(500, "ffmpeg conversion failed")
                return
            data = output.read_bytes()

        self.send_response(200)
        self.send_header("Content-Type", "video/quicktime")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_multipart_form(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "invalid content length")
            return None
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_error(413, "invalid upload size")
            return None
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self.send_error(400, "multipart form data is required")
            return None
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
            + self.rfile.read(length)
        )
        form = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name:
                form[name] = part.get_payload(decode=True)
        return form

    def _transcribe_audio(self, parsed):
        form = self._read_multipart_form()
        if form is None:
            return
        audio = form.get("audio")
        if not audio:
            self.send_error(400, "audio is required")
            return
        try:
            from faster_whisper import WhisperModel
        except Exception as exc:
            self.send_error(500, f"faster-whisper is not available: {exc}")
            return

        query = parse_qs(parsed.query)
        language = query.get("language", ["zh"])[0] or "zh"
        model_name = os.environ.get("WHISPER_MODEL", "base")
        device = os.environ.get("WHISPER_DEVICE", "cpu")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

        with tempfile.TemporaryDirectory(prefix="flow-transcribe-") as temp:
            source = Path(temp) / "recording.webm"
            source.write_bytes(audio)
            try:
                model = WhisperModel(model_name, device=device, compute_type=compute_type)
                segments, info = model.transcribe(
                    str(source),
                    language=language,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 1000},
                    beam_size=5,
                )
                rows = [
                    {"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": segment.text.strip()}
                    for segment in segments
                    if segment.text and segment.text.strip()
                ]
                payload = {
                    "language": getattr(info, "language", language),
                    "duration": getattr(info, "duration", None),
                    "segments": rows,
                }
            except Exception as exc:
                self.send_error(500, f"transcription failed: {exc}")
                return

        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _convert_audio(self, parsed):
        form = self._read_multipart_form()
        if form is None:
            return
        audio = form.get("audio")
        if not audio:
            self.send_error(400, "audio is required")
            return
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.send_error(500, "ffmpeg is not available")
            return
        query = parse_qs(parsed.query)
        fmt = query.get("format", ["mp3"])[0]
        if fmt not in ("mp3", "wav", "aac"):
            fmt = "mp3"
        mime_map = {"mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac"}
        with tempfile.TemporaryDirectory(prefix="flow-audio-") as temp:
            src = Path(temp) / "input.webm"
            src.write_bytes(audio)
            out = Path(temp) / f"output.{fmt}"
            result = subprocess.run(
                [ffmpeg, "-y", "-i", str(src), str(out)],
                capture_output=True,
            )
            if result.returncode != 0:
                self.send_error(500, "audio conversion failed")
                return
            data = out.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime_map.get(fmt, "audio/mpeg"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="recording.{fmt}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _frame_export(self, parsed):
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.send_error(500, "ffmpeg is not available")
            return
        form = self._read_multipart_form()
        if form is None:
            return

        frames = form.get("frames")
        if not frames:
            self.send_error(400, "frames are required")
            return
        query = parse_qs(parsed.query)
        export_format = query.get("format", ["mov"])[0]
        if export_format not in {"mov", "mp4"}:
            self.send_error(400, "invalid export format")
            return
        try:
            fps = max(1, min(60, int(form.get("fps", b"30"))))
            alpha = form.get("alpha", b"0") == b"1"
        except ValueError:
            self.send_error(400, "invalid export parameters")
            return

        with tempfile.TemporaryDirectory(prefix="flow-frame-export-") as temp:
            root = Path(temp)
            zip_path = root / "frames.zip"
            frame_dir = root / "frames"
            frame_dir.mkdir()
            zip_path.write_bytes(frames)
            try:
                with zipfile.ZipFile(zip_path) as archive:
                    members = archive.infolist()
                    if not members or any(Path(item.filename).name != item.filename for item in members):
                        raise ValueError("invalid frame archive")
                    archive.extractall(frame_dir)
            except (zipfile.BadZipFile, ValueError):
                self.send_error(400, "invalid frame archive")
                return

            if export_format == "mov":
                output = root / "flow-animation.mov"
                command = [
                    ffmpeg,
                    "-y",
                    "-framerate",
                    str(fps),
                    "-i",
                    str(frame_dir / "frame-%05d.png"),
                    "-an",
                    "-vf",
                    "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black@0",
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "4" if alpha else "3",
                    "-pix_fmt",
                    "yuva444p10le" if alpha else "yuv422p10le",
                    "-vendor",
                    "apl0",
                    str(output),
                ]
                content_type_out = "video/quicktime"
            elif alpha:
                output = root / "flow-animation.webm"
                command = [
                    ffmpeg,
                    "-y",
                    "-framerate",
                    str(fps),
                    "-i",
                    str(frame_dir / "frame-%05d.png"),
                    "-an",
                    "-vf",
                    "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black@0",
                    "-c:v",
                    "libvpx-vp9",
                    "-pix_fmt",
                    "yuva420p",
                    "-auto-alt-ref",
                    "0",
                    "-b:v",
                    "0",
                    "-crf",
                    "24",
                    str(output),
                ]
                content_type_out = "video/webm"
            else:
                output = root / "flow-animation.mp4"
                command = [
                    ffmpeg,
                    "-y",
                    "-framerate",
                    str(fps),
                    "-i",
                    str(frame_dir / "frame-%05d.png"),
                    "-an",
                    "-vf",
                    "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "18",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(output),
                ]
                content_type_out = "video/mp4"

            result = subprocess.run(command, capture_output=True, text=True, timeout=900)
            if result.returncode != 0 or not output.exists():
                self.send_error(500, "ffmpeg frame export failed")
                return
            data = output.read_bytes()

        self.send_response(200)
        self.send_header("Content-Type", content_type_out)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
