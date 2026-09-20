import os
import secrets
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load .env file from project root
ROOT_DIR = Path(__file__).resolve().parent.parent
env_file = ROOT_DIR / ".env"
load_dotenv(env_file)

# -------------------------------------------------------------
# Authentication & Security (Salted Hashing via bcrypt)
# -------------------------------------------------------------
# User-defined password from .env (plain or hashed)
ACCESS_PASSWORD = os.getenv("ACCESS_PASSWORD", "").strip()
ACCESS_PASSWORD_HASH = os.getenv("ACCESS_PASSWORD_HASH", "").strip()


# Persistent Secret Key for HMAC / Token Salting
SECRET_KEY = os.getenv("SECRET_KEY", "").strip()
if not SECRET_KEY:
    SECRET_KEY = secrets.token_hex(32)

# Web Terminal opt-in flag (Default: False for security)
ENABLE_WEB_TERMINAL = os.getenv("ENABLE_WEB_TERMINAL", "false").lower() in ("true", "1", "yes")

# CORS Allowed Origins
ALLOWED_ORIGINS_RAW = os.getenv("ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_RAW.split(",") if o.strip()] if ALLOWED_ORIGINS_RAW else []

# Server Network
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# -------------------------------------------------------------
# Antigravity Paths (Cross-Platform)
# -------------------------------------------------------------
DEFAULT_BRAIN_DIR = Path(os.path.expanduser("~")) / ".gemini" / "antigravity-cli" / "brain"
BRAIN_DIR = Path(os.getenv("ANTIGRAVITY_BRAIN_DIR", str(DEFAULT_BRAIN_DIR)))

if sys.platform == "win32":
    DEFAULT_AGY_PATH = Path(os.path.expanduser("~")) / "AppData" / "Local" / "agy" / "bin" / "agy.exe"
    DEFAULT_CLOUDFLARED_PATH = Path(r"C:\Program Files (x86)\cloudflared\cloudflared.exe")
else:
    DEFAULT_AGY_PATH = Path(os.path.expanduser("~")) / ".local" / "bin" / "agy"
    DEFAULT_CLOUDFLARED_PATH = Path("/usr/local/bin/cloudflared")

AGY_PATH = os.getenv("AGY_PATH", str(DEFAULT_AGY_PATH) if DEFAULT_AGY_PATH.exists() else "agy")
CLOUDFLARED_PATH = os.getenv("CLOUDFLARED_PATH", str(DEFAULT_CLOUDFLARED_PATH) if DEFAULT_CLOUDFLARED_PATH.exists() else "cloudflared")

# -------------------------------------------------------------
# Models list & Reasoning Efforts
# -------------------------------------------------------------
AVAILABLE_MODELS = [
    {"id": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash", "provider": "Google", "badge": "Latest", "default": True},
    {"id": "gemini-3.7-flash-high", "name": "Gemini 3.7 Flash", "provider": "Google", "badge": "Fast"},
    {"id": "gemini-3.6-flash-high", "name": "Gemini 3.6 Flash", "provider": "Google"},
    {"id": "gemini-3.1-pro-high", "name": "Gemini 3.1 Pro", "provider": "Google", "badge": "Pro"},
    {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "provider": "Anthropic", "badge": "Thinking"},
    {"id": "claude-opus-4-6-thinking", "name": "Claude Opus 4.6", "provider": "Anthropic", "badge": "Deep Think"},
    {"id": "gpt-oss-120b-medium", "name": "GPT-OSS 120B", "provider": "Open", "badge": "Open"}
]

REASONING_EFFORTS = [
    {"id": "low", "name": "Low", "description": "빠르고 가벼운 추론 (간단한 작업)"},
    {"id": "medium", "name": "Medium", "description": "균형 잡힌 추론 및 분석"},
    {"id": "high", "name": "High", "description": "깊은 사고 과정 및 코드 합성", "default": True},
    {"id": "max", "name": "Max", "description": "최대 추론 예산 및 종합 검증"}
]
