"""
token_db.py — SQLite-backed secure token store

Features:
- Tokens stored as SHA-256 hashes (never plaintext in DB)
- Per-token expiry (default 30 days, configurable)
- Session metadata (IP, UA, created_at, last_used)
- Token revocation (logout / revoke all)
- Login attempt rate limiting (per IP, in-memory + DB fallback)
- Thread-safe via WAL mode
"""

import hashlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional, Dict, List

from app.config import ROOT_DIR, SECRET_KEY
import hmac

DB_PATH = ROOT_DIR / "data" / "tokens.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Default token TTL: 30 days
TOKEN_TTL_SECONDS = 30 * 24 * 3600

# Login rate limiting: max N attempts per window per IP
RATE_LIMIT_MAX = 10
RATE_LIMIT_WINDOW = 60  # seconds

_local = threading.local()


def _get_conn() -> sqlite3.Connection:
    """Return a thread-local DB connection."""
    if not hasattr(_local, "conn") or _local.conn is None:
        conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        _local.conn = conn
    return _local.conn


def init_db():
    """Create tables if they don't exist."""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tokens (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash  TEXT    NOT NULL UNIQUE,
            label       TEXT    DEFAULT '',
            ip          TEXT    DEFAULT '',
            user_agent  TEXT    DEFAULT '',
            created_at  INTEGER NOT NULL,
            last_used   INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL,
            revoked     INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_token_hash ON tokens(token_hash);
        CREATE INDEX IF NOT EXISTS idx_expires_revoked ON tokens(expires_at, revoked);

        CREATE TABLE IF NOT EXISTS login_attempts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ip          TEXT    NOT NULL,
            attempted_at INTEGER NOT NULL,
            success     INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, attempted_at);
    """)
    conn.commit()


def _hash_token(token: str) -> str:
    """HMAC-SHA256 hash using server SECRET_KEY as salt."""
    key = SECRET_KEY.encode("utf-8")
    return hmac.new(key, token.encode("utf-8"), hashlib.sha256).hexdigest()

def _legacy_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ──────────────────────────────────────────────
# Token management
# ──────────────────────────────────────────────

def create_token(
    ip: str = "",
    user_agent: str = "",
    label: str = "",
    ttl: int = TOKEN_TTL_SECONDS
) -> str:
    """Generate a new secure token, persist its hash, return the raw token."""
    raw = secrets.token_urlsafe(40)
    h = _hash_token(raw)
    now = int(time.time())
    conn = _get_conn()
    conn.execute(
        """INSERT INTO tokens (token_hash, label, ip, user_agent, created_at, last_used, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (h, label, ip, user_agent, now, now, now + ttl)
    )
    conn.commit()
    return raw


def verify_token(token: Optional[str], ip: str = "") -> bool:
    """Return True if token is valid (exists, not revoked, not expired)."""
    if not token:
        return False
    h = _hash_token(token)
    legacy_h = _legacy_hash(token)
    now = int(time.time())
    conn = _get_conn()
    row = conn.execute(
        "SELECT id FROM tokens WHERE (token_hash=? OR token_hash=?) AND revoked=0 AND expires_at>?",
        (h, legacy_h, now)
    ).fetchone()
    if row:
        conn.execute("UPDATE tokens SET last_used=? WHERE id=?", (now, row["id"]))
        conn.commit()
        return True
    return False


def revoke_token(token: str) -> bool:
    """Revoke a specific token (logout)."""
    h = _hash_token(token)
    legacy_h = _legacy_hash(token)
    conn = _get_conn()
    cur = conn.execute("UPDATE tokens SET revoked=1 WHERE token_hash=? OR token_hash=?", (h, legacy_h))
    conn.commit()
    return cur.rowcount > 0


def revoke_all_tokens():
    """Revoke all tokens (force re-login everywhere)."""
    conn = _get_conn()
    conn.execute("UPDATE tokens SET revoked=1 WHERE revoked=0")
    conn.commit()


def list_sessions() -> List[Dict]:
    """List all active (non-revoked, non-expired) sessions."""
    now = int(time.time())
    conn = _get_conn()
    rows = conn.execute(
        """SELECT id, label, ip, user_agent, created_at, last_used, expires_at
           FROM tokens WHERE revoked=0 AND expires_at>?
           ORDER BY last_used DESC""",
        (now,)
    ).fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "label": r["label"],
            "ip": r["ip"],
            "user_agent": r["user_agent"][:60] if r["user_agent"] else "",
            "created_at": r["created_at"],
            "last_used": r["last_used"],
            "expires_at": r["expires_at"],
        })
    return result


def revoke_session_by_id(session_id: int) -> bool:
    conn = _get_conn()
    cur = conn.execute("UPDATE tokens SET revoked=1 WHERE id=?", (session_id,))
    conn.commit()
    return cur.rowcount > 0


def purge_expired():
    """Delete expired/revoked tokens older than 7 days."""
    cutoff = int(time.time()) - 7 * 24 * 3600
    conn = _get_conn()
    conn.execute("DELETE FROM tokens WHERE (revoked=1 OR expires_at < ?) AND created_at < ?",
                 (int(time.time()), cutoff))
    conn.commit()


# ──────────────────────────────────────────────
# Login rate limiting
# ──────────────────────────────────────────────

# Fast in-memory cache: {ip: [timestamp, ...]}
_rate_cache: Dict[str, List[float]] = {}
_rate_lock = threading.Lock()


def check_rate_limit(ip: str) -> bool:
    """Return True if IP is allowed to attempt login, False if rate-limited."""
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    with _rate_lock:
        attempts = _rate_cache.get(ip, [])
        # Prune old
        attempts = [t for t in attempts if t > window_start]
        _rate_cache[ip] = attempts
        return len(attempts) < RATE_LIMIT_MAX


def record_login_attempt(ip: str, success: bool):
    """Record a login attempt for rate limiting."""
    now = time.time()
    with _rate_lock:
        attempts = _rate_cache.get(ip, [])
        if not success:
            attempts.append(now)
        else:
            # Successful login clears the counter
            attempts = []
        _rate_cache[ip] = attempts

    # Also persist to DB for audit
    conn = _get_conn()
    conn.execute(
        "INSERT INTO login_attempts (ip, attempted_at, success) VALUES (?, ?, ?)",
        (ip, int(now), 1 if success else 0)
    )
    conn.commit()


def get_login_audit(limit: int = 50) -> List[Dict]:
    """Recent login attempts for admin view."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT ip, attempted_at, success FROM login_attempts ORDER BY attempted_at DESC LIMIT ?",
        (limit,)
    ).fetchall()
    return [{"ip": r["ip"], "time": r["attempted_at"], "success": bool(r["success"])} for r in rows]


# Init on import
init_db()
