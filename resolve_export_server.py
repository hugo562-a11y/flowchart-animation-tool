from __future__ import annotations

import shutil
import subprocess
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 8765
ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 512 * 1024 * 1024


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

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
