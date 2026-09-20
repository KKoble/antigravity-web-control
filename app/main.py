import asyncio
import json
from pathlib import Path
from typing import Optional, Dict
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request, Response, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import ROOT_DIR
from app.api import router as api_router
from app.auth import verify_token, get_client_ip
from app.agy_runner import run_agy_stream
from app.live_watcher import live_watcher
from app.token_db import purge_expired

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Start watching ~/.gemini/antigravity-cli/brain for live CLI changes
    await live_watcher.start()
    yield
    # Shutdown: Stop watcher
    await live_watcher.stop()

app = FastAPI(title="Antigravity Web Control", version="1.0.0", lifespan=lifespan)

# ──────────────────────────────────────────────
# Security Headers Middleware
# ──────────────────────────────────────────────
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    # Prevent clickjacking
    response.headers["X-Frame-Options"] = "DENY"
    # Prevent MIME sniffing
    response.headers["X-Content-Type-Options"] = "nosniff"
    # XSS protection (legacy browsers)
    response.headers["X-XSS-Protection"] = "1; mode=block"
    # Referrer policy
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Permissions policy: disable camera/mic/geolocation by default
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response

# ──────────────────────────────────────────────
# Protect /uploads/* — token required
# ──────────────────────────────────────────────
UPLOADS_DIR = ROOT_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

@app.get("/uploads/{filename:path}")
async def serve_upload(filename: str, request: Request, token: Optional[str] = Query(None)):
    """Serve uploaded files only to authenticated users."""
    auth_header = request.headers.get("Authorization")
    candidate = None
    if auth_header:
        parts = auth_header.split()
        candidate = parts[1] if len(parts) == 2 else auth_header
    if not candidate:
        candidate = token
    if not verify_token(candidate, ip=get_client_ip(request)):
        return JSONResponse(status_code=401, content={"detail": "인증이 필요합니다."})
    target = UPLOADS_DIR / filename
    # Path traversal guard
    try:
        target.resolve().relative_to(UPLOADS_DIR.resolve())
    except ValueError:
        return JSONResponse(status_code=403, content={"detail": "접근 금지"})
    if not target.exists():
        return JSONResponse(status_code=404, content={"detail": "파일 없음"})
    return FileResponse(target)

from app.config import ROOT_DIR, ENABLE_WEB_TERMINAL, ALLOWED_ORIGINS

# CORS setup — comply with CORS standard specs
if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    # When allow_origins is wildcard, allow_credentials MUST be False
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# API routes
app.include_router(api_router)

# Static directory setup
STATIC_DIR = ROOT_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

STATIC_EN_DIR = ROOT_DIR / "static_en"
STATIC_EN_DIR.mkdir(exist_ok=True)
app.mount("/static_en", StaticFiles(directory=str(STATIC_EN_DIR)), name="static_en")

@app.get("/")
async def get_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "Antigravity Web Control API Running"}

@app.get("/en")
async def get_index_en():
    index_file = STATIC_EN_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "Antigravity English Web Control API Running"}

# Store active streaming tasks per websocket connection
active_chat_tasks: Dict[str, asyncio.Task] = {}

from starlette.websockets import WebSocketState

async def safe_send_json(ws: WebSocket, data: dict) -> bool:
    """Safely send JSON to WebSocket only if currently connected."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_json(data)
            return True
    except Exception:
        pass
    return False

async def safe_send_text(ws: WebSocket, text: str) -> bool:
    """Safely send text to WebSocket only if currently connected."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_text(text)
            return True
    except Exception:
        pass
    return False

async def safe_close(ws: WebSocket, code: int = status.WS_1000_NORMAL_CLOSURE):
    """Safely close WebSocket without raising RuntimeError if already closing."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.close(code=code)
    except Exception:
        pass


LOCAL_IPS = {"127.0.0.1", "::1", "localhost"}

@app.websocket("/ws/chat")
async def chat_websocket(
    websocket: WebSocket,
    token: Optional[str] = Query(None)
):
    try:
        await websocket.accept()
    except Exception:
        return

    client_ip = get_client_ip(websocket)

    # Step 1: Token verification (query param or initial auth message)
    authenticated = False
    if token and verify_token(token, ip=client_ip):
        authenticated = True

    if not authenticated:
        try:
            # Wait for {"action": "auth", "token": "..."} within 5.0 seconds
            raw_init = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
            init_data = json.loads(raw_init)
            if init_data.get("action") == "auth":
                cand_token = init_data.get("token")
                if verify_token(cand_token, ip=client_ip):
                    authenticated = True
                    await safe_send_json(websocket, {"type": "auth_ok", "message": "인증 완료"})
        except WebSocketDisconnect:
            return
        except Exception:
            pass

    if not authenticated:
        await safe_send_json(websocket, {
            "type": "error",
            "message": "인증 토큰이 유효하지 않습니다. 다시 로그인해주세요."
        })
        await safe_close(websocket, code=status.WS_1008_POLICY_VIOLATION)
        return


    # Subscribe to global CLI events (conversation updates in real-time)
    live_watcher.subscribe_global(websocket)
    conn_id = f"conn_{id(websocket)}"

    from app.process_manager import (
        register_stream_process, unregister_stream_process,
        send_approval, send_question_answer
    )

    async def stream_task_runner(payload: dict):
        prompt = payload.get("prompt", "")
        conv_id = payload.get("conversation_id")
        model = payload.get("model")
        effort = payload.get("effort")
        approval_mode = bool(payload.get("approval_mode", False))

        def on_proc_created(proc):
            register_stream_process(conn_id, proc)

        try:
            async for event in run_agy_stream(
                prompt=prompt,
                conversation_id=conv_id,
                model=model,
                effort=effort,
                cwd=str(ROOT_DIR),
                approval_mode=approval_mode,
                on_process_created=on_proc_created
            ):
                await websocket.send_json(event)
        except asyncio.CancelledError:
            await websocket.send_json({
                "type": "stopped",
                "message": "작업 생성이 중단되었습니다."
            })
        except Exception as e:
            await websocket.send_json({
                "type": "error",
                "message": f"오류 발생: {str(e)}"
            })
        finally:
            unregister_stream_process(conn_id)

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except Exception:
                continue

            action = msg.get("action")

            if action == "watch":
                conv_id = msg.get("conversation_id")
                if conv_id:
                    live_watcher.subscribe(conv_id, websocket)

            elif action == "stop":
                if conn_id in active_chat_tasks and not active_chat_tasks[conn_id].done():
                    active_chat_tasks[conn_id].cancel()
                    await websocket.send_json({"type": "info", "message": "중단 요청됨"})

            elif action == "approval_response":
                action_id = msg.get("action_id", "")
                approved = bool(msg.get("approved", False))
                # Forward to active stream process stdin AND active Web Terminal PTYs
                await send_approval(approved=approved, conn_id=conn_id)

                if not approved:
                    if conn_id in active_chat_tasks and not active_chat_tasks[conn_id].done():
                        active_chat_tasks[conn_id].cancel()
                    await websocket.send_json({
                        "type": "info",
                        "message": f"작업({action_id})이 사용자에 의해 거부되어 취소되었습니다."
                    })
                else:
                    await websocket.send_json({
                        "type": "info",
                        "message": f"작업({action_id})이 승인되어 프로세스에 전달되었습니다."
                    })

            elif action == "question_response":
                action_id = msg.get("action_id", "")
                answer = str(msg.get("answer", ""))
                option_num = msg.get("option_num")
                await send_question_answer(answer=answer, option_num=option_num, conn_id=conn_id)
                await websocket.send_json({
                    "type": "info",
                    "message": f"답변 '{answer}'이(가) 프로세스에 전달되었습니다."
                })

            elif action == "chat":
                if conn_id in active_chat_tasks and not active_chat_tasks[conn_id].done():
                    active_chat_tasks[conn_id].cancel()

                task = asyncio.create_task(stream_task_runner(msg))
                active_chat_tasks[conn_id] = task

    except WebSocketDisconnect:
        pass
    finally:
        unregister_stream_process(conn_id)
        live_watcher.unsubscribe_all(websocket)
        if conn_id in active_chat_tasks:
            task = active_chat_tasks.pop(conn_id)
            if not task.done():
                task.cancel()


# ====================================================================
# Embedded Web Terminal (Xterm.js) — Security Hardened & Cross-Platform
# ====================================================================
@app.websocket("/ws/terminal")
async def terminal_websocket(
    websocket: WebSocket,
    token: Optional[str] = Query(None),
    mode: str = Query("shell"),
    conv_id: Optional[str] = Query(None),
):
    try:
        await websocket.accept()
    except Exception:
        return

    # 1. Check Opt-in Flag
    if not ENABLE_WEB_TERMINAL:
        await safe_send_text(
            websocket,
            "\r\n[보안 차단] 웹 터미널 기능이 현재 비활성화되어 있습니다.\r\n"
            "서버의 .env 파일에서 ENABLE_WEB_TERMINAL=true 로 설정해야 활성화됩니다.\r\n"
        )
        await safe_close(websocket, code=status.WS_1008_POLICY_VIOLATION)
        return

    # 2. Check Client IP (Localhost Only to prevent remote RCE)
    client_ip = get_client_ip(websocket)
    if client_ip and client_ip not in LOCAL_IPS:
        await safe_send_text(
            websocket,
            f"\r\n[보안 차단] 웹 터미널은 외부 접속({client_ip})에서 사용할 수 없습니다.\r\n"
            "서버 로컬 환경(127.0.0.1)에서만 안전하게 실행 가능합니다.\r\n"
        )
        await safe_close(websocket, code=status.WS_1008_POLICY_VIOLATION)
        return

    # 3. Token Authentication
    authenticated = False
    if token and verify_token(token, ip=client_ip):
        authenticated = True
    else:
        try:
            raw_init = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
            init_data = json.loads(raw_init)
            cand = init_data.get("token") or init_data.get("data")
            if verify_token(cand, ip=client_ip):
                authenticated = True
        except WebSocketDisconnect:
            return
        except Exception:
            pass

    if not authenticated:
        await safe_send_text(websocket, "\r\n[인증 실패] 유효한 인증 토큰이 필요합니다.\r\n")
        await safe_close(websocket, code=status.WS_1008_POLICY_VIOLATION)
        return

    # 4. Cross-Platform Terminal Spawn with UTF-8 support for Korean (Hangul)
    import sys
    pty_proc = None
    read_task = None

    if sys.platform == "win32":
        try:
            import winpty
        except ImportError:
            await websocket.send_text("\r\n[오류] pywinpty 패키지가 필요합니다: pip install pywinpty\r\n")
            await websocket.close()
            return

        # Enforce UTF-8 on Windows PowerShell and remove PSReadLine to fix Korean IME input lag & mangled characters
        utf8_init = (
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); "
            "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
            "chcp 65001 > $null; "
            "Remove-Module PSReadLine -ErrorAction SilentlyContinue; "
            "Clear-Host"
        )

        if mode == "agy":
            agy_cmd = f"agy --conversation {conv_id}" if conv_id else "agy -c"
            spawn_command = f"{utf8_init}; Write-Host '🤖 agy CLI 세션 시작: {agy_cmd}' -ForegroundColor Cyan; {agy_cmd}"
        else:
            spawn_command = f"{utf8_init}; Write-Host '⚡ PowerShell UTF-8 세션 준비 완료' -ForegroundColor Green"

        pty_proc = winpty.PtyProcess.spawn(
            ["powershell.exe", "-NoLogo", "-NoExit", "-Command", spawn_command],
            cwd=str(ROOT_DIR),
            dimensions=(24, 80),
            backend=winpty.enums.Backend.ConPTY,
        )
        from app.process_manager import register_pty, unregister_pty
        register_pty(pty_proc)

        async def read_pty_win():
            loop = asyncio.get_event_loop()
            while True:
                try:
                    data = await loop.run_in_executor(None, pty_proc.read, 1024)
                    if data:
                        await websocket.send_text(data)
                    else:
                        await asyncio.sleep(0.02)
                    if not pty_proc.isalive():
                        break
                except Exception:
                    break
            try:
                await websocket.send_text("\r\n[세션 종료]\r\n")
                await websocket.close()
            except Exception:
                pass

        read_task = asyncio.create_task(read_pty_win())

        try:
            while True:
                msg = await websocket.receive_text()
                try:
                    data = json.loads(msg)
                    if data.get("type") == "resize":
                        cols = int(data.get("cols", 80))
                        rows = int(data.get("rows", 24))
                        pty_proc.setwinsize(rows, cols)
                    elif data.get("type") == "input":
                        pty_proc.write(data.get("data", ""))
                except (json.JSONDecodeError, TypeError):
                    pty_proc.write(msg)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            unregister_pty(pty_proc)
            read_task.cancel()
            try:
                pty_proc.terminate(force=True)
            except Exception:
                pass
    else:
        # Non-Windows (Linux/macOS) PTY
        import pty
        import os
        import select
        master_fd, slave_fd = pty.openpty()
        shell_cmd = os.environ.get("SHELL", "/bin/bash")
        import subprocess
        proc = subprocess.Popen(
            [shell_cmd],
            preexec_fn=os.setsid,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=str(ROOT_DIR),
            close_fds=True
        )
        os.close(slave_fd)

        async def read_pty_unix():
            loop = asyncio.get_event_loop()
            while True:
                try:
                    r, _, _ = await loop.run_in_executor(None, select.select, [master_fd], [], [], 0.1)
                    if master_fd in r:
                        data = os.read(master_fd, 1024)
                        if data:
                            await websocket.send_text(data.decode("utf-8", errors="replace"))
                        else:
                            break
                    if proc.poll() is not None:
                        break
                except Exception:
                    break
            try:
                await websocket.send_text("\r\n[세션 종료]\r\n")
                await websocket.close()
            except Exception:
                pass

        read_task = asyncio.create_task(read_pty_unix())

        try:
            while True:
                msg = await websocket.receive_text()
                try:
                    data = json.loads(msg)
                    if data.get("type") == "input":
                        os.write(master_fd, data.get("data", "").encode("utf-8"))
                except (json.JSONDecodeError, TypeError):
                    os.write(master_fd, msg.encode("utf-8"))
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            read_task.cancel()
            try:
                os.close(master_fd)
                proc.terminate()
            except Exception:
                pass

