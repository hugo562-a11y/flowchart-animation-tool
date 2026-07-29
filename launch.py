"""
流程圖動畫工具 - 啟動腳本
由 launch.bat 呼叫，不依賴 PowerShell。
"""
from __future__ import annotations
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).parent
SERVER_URL = "http://127.0.0.1:8765"


def scan_fonts() -> list[str]:
    """讀取 Windows Registry 取得已安裝字型清單。"""
    try:
        import winreg
    except ImportError:
        return []
    pattern = re.compile(r"\s+\((TrueType|OpenType|All res)\)$")
    fonts: set[str] = set()
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
    ]
    for hive, subkey in keys:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                i = 0
                while True:
                    try:
                        name, _, _ = winreg.EnumValue(key, i)
                        clean = pattern.sub("", name).strip()
                        if clean:
                            fonts.add(clean)
                        i += 1
                    except OSError:
                        break
        except OSError:
            pass
    return sorted(fonts)


def install_packages() -> None:
    """依 requirements.txt 自動安裝缺少的套件。"""
    req = ROOT / "requirements.txt"
    if not req.exists():
        return
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(req), "--dry-run", "-q"],
        capture_output=True, text=True,
    )
    if "Would install" not in result.stdout:
        return
    print("首次安裝套件（語音辨識），約需 1-3 分鐘，請稍候...")
    ret = subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(req)])
    if ret.returncode == 0:
        print("套件安裝完成。")
    else:
        print("部分套件安裝失敗，語音辨識功能將無法使用。")


def check_ffmpeg() -> None:
    import shutil
    if not shutil.which("ffmpeg"):
        print()
        print("注意：找不到 FFmpeg，影片輸出和 MP3 轉換將無法使用。")
        print("      下載：https://ffmpeg.org/download.html")
        print("      安裝後請將 bin 目錄加入系統 PATH。")
        print()


def server_ready() -> bool:
    try:
        with urllib.request.urlopen(f"{SERVER_URL}/api/health", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def start_server() -> None:
    if server_ready():
        return
    kwargs: dict = {"cwd": str(ROOT)}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    subprocess.Popen([sys.executable, str(ROOT / "resolve_export_server.py")], **kwargs)
    for _ in range(40):
        time.sleep(0.15)
        if server_ready():
            return
    print("警告：伺服器啟動逾時，部分功能（影片輸出）可能無法使用。")


def open_browser() -> None:
    url = f"{SERVER_URL}/index.html"
    env = os.environ
    candidates = [
        os.path.join(env.get("ProgramFiles", ""),      r"Google\Chrome\Application\chrome.exe"),
        os.path.join(env.get("ProgramFiles(x86)", ""), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(env.get("LOCALAPPDATA", ""),      r"Google\Chrome\Application\chrome.exe"),
        os.path.join(env.get("ProgramFiles(x86)", ""), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(env.get("ProgramFiles", ""),      r"Microsoft\Edge\Application\msedge.exe"),
    ]
    for browser in candidates:
        if os.path.isfile(browser):
            subprocess.Popen([browser, f"--app={url}"])
            return
    import webbrowser
    webbrowser.open(url)


def main() -> None:
    print("流程圖動畫工具 啟動中...")

    fonts = scan_fonts()
    if fonts:
        font_js = ROOT / "installed-fonts.js"
        font_js.write_text(
            f"globalThis.INSTALLED_FONTS = {json.dumps(fonts, ensure_ascii=False)};",
            encoding="utf-8",
        )
        print(f"字型掃描完成（{len(fonts)} 個）。")

    install_packages()
    check_ffmpeg()
    start_server()
    open_browser()
    print("已啟動，可關閉此視窗。")


if __name__ == "__main__":
    main()
