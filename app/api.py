import time
import shutil
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request, status, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

from app.config import AVAILABLE_MODELS, REASONING_EFFORTS, CLOUDFLARED_PATH, ROOT_DIR
from app.auth import (
    require_auth, require_auth_login,
    revoke_token, get_client_ip,
    create_access_token, verify_token,
    save_new_password, verify_password,
)
from app.token_db import (
    list_sessions, revoke_session_by_id, revoke_all_tokens, purge_expired,
    get_login_audit,
)
from app.brain_service import (
    list_conversations, get_conversation_messages, delete_conversation,
    validate_conv_id, get_pending_action
)
from app.quota_service import quota_service

router = APIRouter(prefix="/api")

UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Allowed upload extensions whitelist
ALLOWED_UPLOAD_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
    ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json",
    ".pdf", ".zip", ".tar", ".gz", ".csv", ".log", ".yaml", ".yml",
    ".html", ".css", ".ini", ".conf", ".sh", ".bat"
}
MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20MB per file
LOCAL_IPS = {"127.0.0.1", "::1", "localhost"}

# Tunnel global state if started by runner
tunnel_state = {
    "active": False,
    "url": None,
    "process": None
}


# ──────────────────────────────────────────────
# Auth Endpoints
# ──────────────────────────────────────────────

class LoginRequest(BaseModel):
    password: str

@router.post("/auth/login")
async def login(req: LoginRequest, request: Request):
    """Password login — returns a long-lived token stored in SQLite."""
    token = require_auth_login(request, req.password)
    return {"ok": True, "token": token, "message": "인증되었습니다."}


@router.get("/auth/verify")
async def verify_current_token(token: str = Depends(require_auth)):
    return {"ok": True}


@router.post("/auth/logout")
async def logout(request: Request, token: str = Depends(require_auth)):
    """Revoke the current token (logout this session)."""
    revoke_token(token)
    return {"ok": True, "message": "로그아웃 되었습니다."}


@router.get("/auth/sessions")
async def get_sessions(_: str = Depends(require_auth)):
    """List all active sessions (for the security dashboard)."""
    purge_expired()
    return {"ok": True, "sessions": list_sessions()}


@router.delete("/auth/sessions/{session_id}")
async def revoke_session(session_id: int, _: str = Depends(require_auth)):
    """Revoke a specific session by ID."""
    ok = revoke_session_by_id(session_id)
    return {"ok": ok}


@router.post("/auth/revoke-all")
async def revoke_all(request: Request, _: str = Depends(require_auth)):
    """Revoke ALL tokens — forces re-login on every device."""
    revoke_all_tokens()
    return {"ok": True, "message": "모든 세션이 폐기되었습니다. 다시 로그인해 주세요."}


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

@router.post("/auth/change-password")
async def change_password(req: ChangePasswordRequest, _: str = Depends(require_auth)):
    """Change access password with salted bcrypt hash."""
    if not verify_password(req.old_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="현재 비밀번호가 일치하지 않습니다."
        )
    if len(req.new_password) < 4:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="새 비밀번호는 최소 4자 이상이어야 합니다."
        )
    save_new_password(req.new_password)
    return {"ok": True, "message": "비밀번호가 Salt 암호화(bcrypt)되어 안전하게 변경되었습니다."}



@router.get("/auth/audit")
async def get_audit_log(_: str = Depends(require_auth)):
    """Recent login attempt audit log."""
    return {"ok": True, "attempts": get_login_audit(limit=100)}


@router.get("/models")
async def get_models(_: bool = Depends(require_auth)):
    return {
        "models": AVAILABLE_MODELS,
        "efforts": REASONING_EFFORTS,
        "default_model": "gemini-3.8-flash-high",
        "default_effort": "high"
    }

@router.get("/conversations")
async def get_conversations(_: bool = Depends(require_auth)):
    conversations = list_conversations()
    return {"conversations": conversations}

@router.get("/conversations/{conv_id}")
async def get_conversation(conv_id: str, _: bool = Depends(require_auth)):
    if not validate_conv_id(conv_id):
        raise HTTPException(status_code=400, detail="유효하지 않은 대화 ID 형식입니다.")
    messages = get_conversation_messages(conv_id)
    pending_action = get_pending_action(conv_id)
    return {
        "conversation_id": conv_id,
        "messages": messages,
        "pending_action": pending_action
    }

@router.delete("/conversations/{conv_id}")
async def remove_conversation(conv_id: str, _: bool = Depends(require_auth)):
    if not validate_conv_id(conv_id):
        raise HTTPException(status_code=400, detail="유효하지 않은 대화 ID 형식입니다.")
    success = delete_conversation(conv_id)
    if not success:
        raise HTTPException(status_code=404, detail="대화를 찾을 수 없거나 삭제할 수 없습니다.")
    return {"ok": True, "conversation_id": conv_id}

# ------------------------------------------------------------------
# File Explorer API
# ------------------------------------------------------------------

@router.get("/files")
async def list_files(path: str = "", _: bool = Depends(require_auth)):
    """List files in a directory relative to ROOT_DIR."""
    import os
    base = ROOT_DIR
    target = (base / path).resolve() if path else base.resolve()
    # Security: must stay within ROOT_DIR
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="접근 금지 경로")

    if not target.exists():
        raise HTTPException(status_code=404, detail="경로를 찾을 수 없습니다")

    if target.is_file():
        # Return file content
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
            ext = target.suffix.lower().lstrip(".")
            return {"ok": True, "type": "file", "name": target.name, "path": path, "content": content, "ext": ext}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # List directory
    entries = []
    IGNORED = {".git", "__pycache__", "node_modules", ".venv", "venv", ".env", "uploads"}
    try:
        for item in sorted(target.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
            if item.name.startswith(".") or item.name in IGNORED:
                continue
            rel = str(item.relative_to(base)).replace("\\", "/")
            entries.append({
                "name": item.name,
                "path": rel,
                "type": "dir" if item.is_dir() else "file",
                "ext": item.suffix.lower().lstrip(".") if item.is_file() else None,
                "size": item.stat().st_size if item.is_file() else None,
            })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    parent = str(Path(path).parent).replace("\\", "/") if path else ""
    return {"ok": True, "type": "dir", "path": path, "parent": parent, "entries": entries}


class FileSaveRequest(BaseModel):
    path: str
    content: str

@router.post("/files/save")
async def save_file(req: FileSaveRequest, _: bool = Depends(require_auth)):
    """Save file content (must be within ROOT_DIR)."""
    base = ROOT_DIR.resolve()
    target = (base / req.path).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=403, detail="접근 금지 경로")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(req.content, encoding="utf-8")
        return {"ok": True, "path": req.path, "size": target.stat().st_size}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/files/download")
async def download_file(path: str, _: str = Depends(require_auth)):
    """Download a file securely from ROOT_DIR."""
    if not path:
        raise HTTPException(status_code=400, detail="파일 경로가 필요합니다.")
    base = ROOT_DIR.resolve()
    target = (base / path).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=403, detail="접근 금지 경로")

    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    return FileResponse(
        path=str(target),
        filename=target.name,
        media_type="application/octet-stream"
    )


# Session-level token usage tracking
session_tokens = {
    "input_tokens": 0,
    "output_tokens": 0,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 0,
}

@router.get("/quota")
async def get_quota(force: bool = False, _: bool = Depends(require_auth)):
    real_quota = quota_service.fetch_real_quota(force=force)
    real_quota["tokens"] = session_tokens
    return {
        "ok": True,
        "quota": real_quota
    }

@router.get("/tunnel/status")
async def get_tunnel_status(_: bool = Depends(require_auth)):
    return {
        "active": tunnel_state["active"],
        "url": tunnel_state["url"],
        "cloudflared_installed": bool(CLOUDFLARED_PATH)
    }

import re

@router.post("/upload")
async def upload_files(
    files: List[UploadFile] = File(...),
    _: bool = Depends(require_auth)
):
    saved_files = []
    for file in files:
        raw_name = Path(file.filename).name
        # Sanitize filename: allow alphanumeric, underscore, dash, and dot only
        safe_filename = re.sub(r"[^a-zA-Z0-9_.\-]", "_", raw_name).strip("._")
        if not safe_filename:
            safe_filename = f"upload_{int(time.time())}"

        ext = Path(safe_filename).suffix.lower()
        if ext not in ALLOWED_UPLOAD_EXTS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"허용되지 않는 파일 확장자입니다: {ext}"
            )

        unique_name = f"{int(time.time())}_{safe_filename}"
        dest_path = UPLOAD_DIR / unique_name

        # Enforce size limit with chunk streaming (20MB)
        total_size = 0
        chunk_size = 1024 * 64  # 64KB
        try:
            with open(dest_path, "wb") as buffer:
                while True:
                    chunk = await file.read(chunk_size)
                    if not chunk:
                        break
                    total_size += len(chunk)
                    if total_size > MAX_UPLOAD_SIZE:
                        buffer.close()
                        dest_path.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail=f"파일 크기 초과 (최대 20MB): {raw_name}"
                        )
                    buffer.write(chunk)
        except Exception as e:
            dest_path.unlink(missing_ok=True)
            if isinstance(e, HTTPException):
                raise e
            raise HTTPException(status_code=500, detail=f"파일 업로드 처리 오류: {str(e)}")

        is_image = ext in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]
        saved_files.append({
            "original_name": raw_name,
            "stored_name": unique_name,
            "path": str(dest_path),
            "url": f"/uploads/{unique_name}",
            "size": total_size,
            "is_image": is_image
        })

    return {"ok": True, "files": saved_files}

class OpenTerminalRequest(BaseModel):
    conversation_id: Optional[str] = None

@router.post("/cli/open-terminal")
async def open_cli_terminal(
    req: OpenTerminalRequest,
    request: Request,
    _: bool = Depends(require_auth)
):
    # Only allow from local IPs to prevent remote screen takeover attacks
    client_ip = get_client_ip(request)
    if client_ip and client_ip not in LOCAL_IPS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="외부(원격) 접속 환경에서는 서버 로컬 콘솔 창 띄우기가 제한됩니다. 웹 내장 터미널을 이용해 주세요."
        )

    conv_id = req.conversation_id
    if conv_id:
        if not validate_conv_id(conv_id):
            raise HTTPException(status_code=400, detail="유효하지 않은 대화 ID 형식입니다.")
        cmd_str = f"agy --conversation {conv_id}"
    else:
        cmd_str = "agy -c"

    try:
        import subprocess
        import sys
        if sys.platform == "win32":
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "powershell", "-NoExit", "-Command", cmd_str],
                cwd=str(ROOT_DIR)
            )
        elif sys.platform == "darwin":
            # macOS Terminal app
            subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script "{cmd_str}"'])
        else:
            # Linux fallback
            subprocess.Popen(["x-terminal-emulator", "-e", cmd_str], cwd=str(ROOT_DIR))

        return {
            "ok": True,
            "command": cmd_str,
            "message": f"CLI 터미널 실행: {cmd_str}"
        }
    except Exception as e:
        return {
            "ok": False,
            "command": cmd_str,
            "message": f"터미널 실행 오류: {str(e)}"
        }

class ApprovalRequest(BaseModel):
    action_id: str
    approved: bool = True
    answer: Optional[str] = None
    option_num: Optional[int] = None

@router.post("/approval")
async def post_approval(req: ApprovalRequest, _: bool = Depends(require_auth)):
    """Approve or reject pending action across active CLI streams and Web Terminals."""
    from app.process_manager import send_approval, send_question_answer
    if req.answer is not None or req.option_num is not None:
        result = await send_question_answer(answer=req.answer or "", option_num=req.option_num)
    else:
        result = await send_approval(approved=req.approved)
    return result

class TerminalInputRequest(BaseModel):
    data: str

@router.post("/terminal/input")
async def post_terminal_input(req: TerminalInputRequest, _: bool = Depends(require_auth)):
    """Broadcast raw keystrokes/data to all active Web Terminal PTY sessions."""
    from app.process_manager import broadcast_terminal_input
    delivered = broadcast_terminal_input(req.data)
    return {"ok": True, "delivered_count": delivered}



