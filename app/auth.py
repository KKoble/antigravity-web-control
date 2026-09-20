"""
auth.py — Secure authentication layer

- Passwords compared with hmac.compare_digest (timing-safe)
- Tokens stored as SHA-256 hashes in SQLite via token_db
- require_auth dependency checks Bearer header OR ?token= query param
- get_client_ip() extracts real IP through Cloudflare / reverse proxies
"""

import hmac
import re
from typing import Optional

import bcrypt
from fastapi import HTTPException, Header, Query, Request, status

from app.config import ACCESS_PASSWORD, ACCESS_PASSWORD_HASH, ROOT_DIR
from app.token_db import (
    create_token as _create_token,
    verify_token as _verify_token,
    revoke_token as _revoke_token,
    check_rate_limit,
    record_login_attempt,
)

# In-memory cached salted password hash
_current_password_hash: str = ACCESS_PASSWORD_HASH

def hash_password(password: str) -> str:
    """Generate bcrypt salted hash with cryptographic salt (12 rounds)."""
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")

def save_new_password(new_password: str) -> str:
    """Hash password with cryptographic salt and persist to .env file."""
    global _current_password_hash
    h = hash_password(new_password)
    _current_password_hash = h

    env_path = ROOT_DIR / ".env"
    if env_path.exists():
        try:
            text = env_path.read_text(encoding="utf-8")
            if "ACCESS_PASSWORD_HASH=" in text:
                text = re.sub(r'ACCESS_PASSWORD_HASH=.*', f'ACCESS_PASSWORD_HASH={h}', text)
            else:
                text += f"\nACCESS_PASSWORD_HASH={h}\n"
            # Comment out plain password for security
            text = re.sub(r'^ACCESS_PASSWORD=.*', '# ACCESS_PASSWORD= (Salted & saved in ACCESS_PASSWORD_HASH below)', text, flags=re.MULTILINE)
            env_path.write_text(text, encoding="utf-8")
        except Exception as e:
            print("[Auth] Could not update .env file:", e)

    return h

def verify_password(password: str) -> bool:
    """Timing-safe salted password comparison using bcrypt."""
    global _current_password_hash

    # Dev mode: no password configured anywhere
    if not _current_password_hash and not ACCESS_PASSWORD:
        return True

    # 1. Primary check: bcrypt salted hash
    if _current_password_hash:
        try:
            return bcrypt.checkpw(password.encode("utf-8"), _current_password_hash.encode("utf-8"))
        except Exception:
            return False

    # 2. Fallback: plain password from .env -> verify and auto-upgrade to salted hash
    if ACCESS_PASSWORD:
        if hmac.compare_digest(password.encode("utf-8"), ACCESS_PASSWORD.encode("utf-8")):
            try:
                save_new_password(password)
            except Exception:
                pass
            return True

    return False


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def get_client_ip(request: Optional[Request] = None) -> str:
    """Extract the real client IP, respecting Cloudflare / proxy headers."""
    if request is None:
        return ""
    # Cloudflare sets CF-Connecting-IP
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    # Standard reverse-proxy header
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    # Fallback to direct connection
    if request.client:
        return request.client.host
    return ""


# ──────────────────────────────────────────────
# Token lifecycle (delegated to token_db)
# ──────────────────────────────────────────────

def create_access_token(ip: str = "", user_agent: str = "", label: str = "") -> str:
    """Issue a new persistent token. Returns the raw token (store client-side)."""
    return _create_token(ip=ip, user_agent=user_agent, label=label)


def verify_token(token: Optional[str], ip: str = "") -> bool:
    """Return True if token is valid (not expired, not revoked)."""
    if not ACCESS_PASSWORD:
        return True
    return _verify_token(token, ip=ip)


def revoke_token(token: str) -> bool:
    """Revoke (logout) a specific token."""
    return _revoke_token(token)


# ──────────────────────────────────────────────
# FastAPI dependency
# ──────────────────────────────────────────────

def _extract_token(authorization: Optional[str], token: Optional[str]) -> Optional[str]:
    """Pull raw token from Authorization header or ?token= query param."""
    if authorization:
        parts = authorization.split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            return parts[1]
        # Bare token (fallback)
        return authorization
    if token:
        return token
    return None


def require_auth(
    request: Request,
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None),
):
    """
    FastAPI dependency — raises 401 if token is missing/invalid.
    Attaches request.state.token for downstream use (e.g., logout).
    """
    candidate = _extract_token(authorization, token)
    ip = get_client_ip(request)

    if not verify_token(candidate, ip=ip):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효한 인증 토큰이 필요합니다. 다시 로그인해 주세요.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Stash for logout endpoint
    request.state.token = candidate
    return candidate  # return raw token so endpoints can use it


def require_auth_login(request: Request, password: str) -> str:
    """
    Validates password with rate-limit guard.
    Returns new token on success, raises 429/401 on failure.
    """
    ip = get_client_ip(request)

    if not check_rate_limit(ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="로그인 시도 횟수 초과. 잠시 후 다시 시도해 주세요.",
        )

    if not verify_password(password):
        record_login_attempt(ip, success=False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="비밀번호가 일치하지 않습니다.",
        )

    ua = request.headers.get("user-agent", "")[:200]
    token = create_access_token(ip=ip, user_agent=ua)
    record_login_attempt(ip, success=True)
    return token
