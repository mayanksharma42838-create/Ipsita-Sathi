"""Shared hardening helpers: rate limits, URL checks, magic bytes, passwords."""

from __future__ import annotations

import ipaddress
import re
import threading
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

# ─── Rate limiting (in-process sliding window) ───────────────────────

_lock = threading.Lock()
_hits: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(key: str, limit: int, window_sec: float) -> bool:
    """Return True if allowed; False if over limit."""
    now = time.monotonic()
    with _lock:
        # Prevent memory leaks by periodically sweeping stale rate limit keys
        if len(_hits) > 500:
            stale_keys = [
                k for k, q in _hits.items()
                if not q or (now - q[-1] > window_sec)
            ]
            for k in stale_keys:
                del _hits[k]

        q = _hits[key]
        while q and now - q[0] > window_sec:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


def client_ip() -> str:
    from flask import request

    # Trust direct peer only (no X-Forwarded-For spoofing unless behind known proxy)
    return (request.remote_addr or "unknown").strip()


def rate_or_429(bucket: str, limit: int, window_sec: float):
    """Flask-friendly: returns (response, status) if limited, else None."""
    from flask import jsonify

    ip = client_ip()
    if not rate_limit(f"{bucket}:{ip}", limit, window_sec):
        return jsonify({"error": "Too many requests. Slow down."}), 429
    return None


# ─── Password policy ─────────────────────────────────────────────────

COMMON_PASSWORDS = frozenset(
    {
        "password",
        "password123",
        "123456789012",
        "1234567890",
        "qwertyuiop",
        "letmein12345",
        "iloveyou1234",
        "adminadmin12",
        "welcome12345",
        "monkey123456",
    }
)


def validate_password(password: str, min_len: int = 12) -> str | None:
    """Return error message or None if OK."""
    if not password or len(password) < min_len:
        return f"Password must be at least {min_len} characters"
    if password.lower() in COMMON_PASSWORDS:
        return "Password is too common"
    if password.isdigit() or password.isalpha():
        return "Password must include letters and numbers or symbols"
    return None


def sanitize_display_name(name: str, max_len: int = 64) -> str | None:
    cleaned = (name or "").strip()[:max_len]
    if not cleaned:
        return None
    if re.search(r"[<>\"'`\\]", cleaned):
        return None
    if re.search(r"[\x00-\x1f\x7f]", cleaned):
        return None
    return cleaned


# ─── URL / FilmTV host policy ────────────────────────────────────────

_BLOCKED_HOST_SUFFIXES = (
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "googlevideo.com",
    "vimeo.com",
    "dailymotion.com",
    "twitch.tv",
    "netflix.com",
    "primevideo.com",
    "hotstar.com",
    "disneyplus.com",
)


def _host_blocked(host: str) -> bool:
    host = host.lower().rstrip(".")
    return any(host == b or host.endswith("." + b) for b in _BLOCKED_HOST_SUFFIXES)


def _is_private_or_local(host: str) -> bool:
    h = host.lower().rstrip(".")
    if h in ("localhost", "localhost.localdomain", "0.0.0.0"):
        return True
    if h.endswith(".local") or h.endswith(".internal") or h.endswith(".lan"):
        return True
    import socket
    try:
        try:
            ip = ipaddress.ip_address(h)
        except ValueError:
            # Resolve to IP to prevent DNS rebinding attacks (e.g. nip.io)
            resolved_ip = socket.gethostbyname(h)
            ip = ipaddress.ip_address(resolved_ip)
        return bool(
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        )
    except (ValueError, socket.gaierror):
        # Hostname resolution failed or blocked
        if h in ("metadata.google.internal", "metadata"):
            return True
        return False


def validate_direct_video_url(url: str, allowed_ext: set[str]) -> str | None:
    """HTTPS-only direct video URL. Returns error or None."""
    if not url or len(url) > 2048:
        return "Invalid URL"
    try:
        parsed = urlparse(url)
    except Exception:
        return "Invalid URL"
    if parsed.scheme != "https":
        return "Only HTTPS direct video URLs are allowed"
    host = parsed.hostname or ""
    if not host:
        return "Invalid URL host"
    if _host_blocked(host):
        return "Streaming sites are not allowed — upload a file instead"
    if _is_private_or_local(host):
        return "Private / local network URLs are blocked"
    path = (parsed.path or "").lower()
    if not any(path.endswith(ext) for ext in allowed_ext):
        return "URL must end with a direct video extension (e.g. .mp4, .webm)"
    return None


def sanitize_instagram_url(url: str) -> str | None:
    """Allow only https Instagram post/reel paths. Returns cleaned URL or None."""
    if not url:
        return None
    url = url.strip()[:1024]
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    if parsed.scheme != "https":
        return None
    host = (parsed.hostname or "").lower()
    if host not in ("www.instagram.com", "instagram.com"):
        return None
    path = parsed.path or ""
    if not re.match(r"^/(p|reel|reels|tv)/[\w\-]+/?", path):
        return None
    # Canonical https://www.instagram.com/...
    clean_path = path if path.endswith("/") else path + "/"
    return f"https://www.instagram.com{clean_path}"


# ─── Magic-byte file validation ──────────────────────────────────────

_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
)

_WEBP_RIFF = b"RIFF"
_WEBP_TAG = b"WEBP"


def sniff_image_ext(header: bytes) -> str | None:
    if len(header) >= 12 and header[:4] == _WEBP_RIFF and header[8:12] == _WEBP_TAG:
        return ".webp"
    for magic, ext in _IMAGE_MAGIC:
        if header.startswith(magic):
            return ".jpg" if ext == ".jpg" else ext
    return None


def sniff_audio_ok(header: bytes) -> bool:
    # Ogg, WebM/EBML, ID3/MP3, fLaC, RIFF/WAVE, ftyp (m4a)
    if header.startswith(b"OggS"):
        return True
    if header.startswith(b"\x1a\x45\xdf\xa3"):  # EBML / webm
        return True
    if header.startswith(b"ID3") or header[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return True
    if header.startswith(b"fLaC"):
        return True
    if header.startswith(b"RIFF") and b"WAVE" in header[:16]:
        return True
    if len(header) >= 8 and header[4:8] == b"ftyp":
        return True
    return False


def sniff_video_ok(header: bytes) -> bool:
    if header.startswith(b"\x1a\x45\xdf\xa3"):  # webm
        return True
    if header.startswith(b"OggS"):
        return True
    if len(header) >= 8 and header[4:8] == b"ftyp":  # mp4/mov/m4v
        return True
    # Matroska often EBML too; some mkv start with EBML
    return False


def read_upload_header(file_storage, n: int = 32) -> bytes:
    pos = file_storage.stream.tell()
    header = file_storage.stream.read(n)
    file_storage.stream.seek(pos)
    return header or b""
