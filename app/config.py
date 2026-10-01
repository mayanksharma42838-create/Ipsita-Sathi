"""Application configuration — production-safe defaults."""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
INSTANCE_DIR = BASE_DIR / "instance"
MEDIA_DIR = BASE_DIR / "media_storage"
THEMES_DIR = MEDIA_DIR / "themes"
UPLOADS_DIR = MEDIA_DIR / "uploads"
DOODLES_DIR = MEDIA_DIR / "doodles"
FILMTV_DIR = MEDIA_DIR / "filmtv"

for d in (INSTANCE_DIR, MEDIA_DIR, THEMES_DIR, UPLOADS_DIR, DOODLES_DIR, FILMTV_DIR):
    d.mkdir(parents=True, exist_ok=True)


def _cors_origins() -> list[str] | str:
    raw = os.environ.get("CORS_ORIGINS", "http://127.0.0.1:5000")
    if isinstance(raw, str) and "," in raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return raw



class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY") or os.urandom(32).hex()
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", f"sqlite:///{INSTANCE_DIR / 'ipsita_sathi.db'}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Keep Flask's request ceiling above FilmTV's per-file limit.
    FILMTV_MAX_BYTES = int(os.environ.get("FILMTV_MAX_BYTES", 2 * 1024 * 1024 * 1024))
    MAX_CONTENT_LENGTH = int(
        os.environ.get("MAX_CONTENT_LENGTH", FILMTV_MAX_BYTES + 1024 * 1024)
    )
    CHAT_MEDIA_MAX_BYTES = int(os.environ.get("CHAT_MEDIA_MAX_BYTES", 25 * 1024 * 1024))
    MAX_CIPHERTEXT_CHARS = int(os.environ.get("MAX_CIPHERTEXT_CHARS", 32768))  # 32KB
    THEME_MAX_BYTES = int(os.environ.get("THEME_MAX_BYTES", 8 * 1024 * 1024))
    DOODLE_MAX_BYTES = int(os.environ.get("DOODLE_MAX_BYTES", 4 * 1024 * 1024))

    MEDIA_DIR = str(MEDIA_DIR)
    THEMES_DIR = str(THEMES_DIR)
    UPLOADS_DIR = str(UPLOADS_DIR)
    DOODLES_DIR = str(DOODLES_DIR)
    FILMTV_DIR = str(FILMTV_DIR)

    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "0") == "1"

    MAX_ROOM_MEMBERS = 2
    MIN_PASSWORD_LENGTH = int(os.environ.get("MIN_PASSWORD_LENGTH", 12))
    SESSION_IDLE_RESUME_SECONDS = int(os.environ.get("SESSION_IDLE_RESUME_SECONDS", 3600))

    ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
    ALLOWED_AUDIO_EXT = {".webm", ".ogg", ".mp3", ".wav", ".m4a"}
    ALLOWED_VIDEO_EXT = {".mp4", ".webm", ".ogg", ".mov", ".mkv", ".m4v"}
    ALLOWED_DOC_EXT = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt"}


    CORS_ORIGINS = _cors_origins()

    # Rate limits: (count, window_seconds)
    RL_AUTH = (8, 60)
    RL_MESSAGES = (30, 60)
    RL_UPLOAD = (10, 60)
    RL_FILMTV = (20, 60)
    RL_SOCKET = (120, 60)
