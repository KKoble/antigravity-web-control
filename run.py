import os
import sys
import re
import argparse
import subprocess
import threading
import time
from pathlib import Path

# Force UTF-8 for console output on Windows
if sys.platform == "win32":
    try:
        if sys.stdout and hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if sys.stderr and hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import uvicorn

from app.config import HOST, PORT, ACCESS_PASSWORD, CLOUDFLARED_PATH
from app.api import tunnel_state

def run_cloudflared(local_port: int):
    """Start cloudflared in a background thread and capture the public trycloudflare.com URL."""
    if not os.path.exists(CLOUDFLARED_PATH):
        print(f"\n[!] cloudflared.exe 를 찾을 수 없습니다: {CLOUDFLARED_PATH}")
        print("    로컬 모드로만 계속 실행됩니다.\n")
        return

    cmd = [CLOUDFLARED_PATH, "tunnel", "--url", f"http://localhost:{local_port}"]
    print("\n[~] Cloudflare Tunnel 시작 중...")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        tunnel_state["process"] = proc

        # Scan for URL in output
        url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
        for line in proc.stdout:
            match = url_pattern.search(line)
            if match:
                public_url = match.group(0)
                tunnel_state["active"] = True
                tunnel_state["url"] = public_url
                print("\n" + "=" * 60)
                print(" [★] Cloudflare Tunnel 공개 URL 연결 성공!")
                print(f" [URL] {public_url}")
                print(f" [비밀번호] {ACCESS_PASSWORD}")
                print("=" * 60 + "\n")
                break
    except Exception as e:
        print(f"\n[!] Cloudflare Tunnel 실행 중 오류: {e}\n")

def main():
    parser = argparse.ArgumentParser(description="Antigravity Web Control Launcher")
    parser.add_argument("--host", default=HOST, help=f"Host (default: {HOST})")
    parser.add_argument("--port", type=int, default=PORT, help=f"Port (default: {PORT})")
    parser.add_argument("--cloudflared", action="store_true", help="Launch Cloudflare Tunnel automatically")
    parser.add_argument("--password", default=None, help="Override access password")
    args = parser.parse_args()

    if args.password:
        import app.config
        app.config.ACCESS_PASSWORD = args.password

    print("\n" + "=" * 60)
    print("      Antigravity Web Control Dashboard      ")
    print("=" * 60)
    print(f" - 로컬 주소: http://localhost:{args.port}")
    print(f" - 네트워크:  http://127.0.0.1:{args.port}")
    print(f" - 접속 암호: {ACCESS_PASSWORD}")
    print("=" * 60 + "\n")

    if args.cloudflared:
        t = threading.Thread(target=run_cloudflared, args=(args.port,), daemon=True)
        t.start()

    # Start FastAPI server via Uvicorn
    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=False, log_level="info")

if __name__ == "__main__":
    main()
