from __future__ import annotations

import time
from app.security import (
    rate_limit,
    _hits,
    validate_password,
    sanitize_display_name,
    validate_direct_video_url,
    sanitize_instagram_url,
    sniff_image_ext,
    sniff_audio_ok,
    sniff_video_ok,
)


def test_rate_limiter_allows_and_blocks():
    key = "test_user_key"
    _hits.pop(key, None)

    # Allow 3 hits in 10 seconds
    assert rate_limit(key, 3, 10.0) is True
    assert rate_limit(key, 3, 10.0) is True
    assert rate_limit(key, 3, 10.0) is True
    # 4th hit should be blocked
    assert rate_limit(key, 3, 10.0) is False

    _hits.pop(key, None)


def test_rate_limiter_stale_key_cleanup():
    _hits.clear()
    # Populate >500 stale keys
    now = time.monotonic()
    for i in range(505):
        _hits[f"stale_key_{i}"].append(now - 100.0)

    # Calling rate_limit should trigger cleanup of stale keys
    assert rate_limit("active_key", 10, 60.0) is True
    assert len(_hits) < 500


def test_validate_password():
    assert validate_password("short") is not None
    assert validate_password("password123") is not None  # too common
    assert validate_password("12345678901234") is not None  # all digits
    assert validate_password("ValidPassword123!") is None


def test_sanitize_display_name():
    assert sanitize_display_name("  Alice  ") == "Alice"
    assert sanitize_display_name("<script>alert(1)</script>") is None
    assert sanitize_display_name("Bob\\") is None
    assert sanitize_display_name("") is None


def test_validate_direct_video_url():
    allowed = {".mp4", ".webm"}
    assert validate_direct_video_url("http://example.com/video.mp4", allowed) == "Only HTTPS direct video URLs are allowed"
    assert validate_direct_video_url("https://youtube.com/watch?v=123", allowed) == "Streaming sites are not allowed — upload a file instead"
    assert validate_direct_video_url("https://127.0.0.1/video.mp4", allowed) == "Private / local network URLs are blocked"
    assert validate_direct_video_url("https://example.com/video.avi", allowed) == "URL must end with a direct video extension (e.g. .mp4, .webm)"
    assert validate_direct_video_url("https://cdn.example.com/video.mp4", allowed) is None


def test_sanitize_instagram_url():
    assert sanitize_instagram_url("http://instagram.com/p/123") is None
    assert sanitize_instagram_url("https://notinstagram.com/p/123") is None
    assert sanitize_instagram_url("https://www.instagram.com/p/C123abc/") == "https://www.instagram.com/p/C123abc/"
    assert sanitize_instagram_url("https://www.instagram.com/reel/C456def") == "https://www.instagram.com/reel/C456def/"


def test_magic_byte_sniffers():
    png_header = b"\x89PNG\r\n\x1a\n" + bytes(16)
    jpg_header = b"\xff\xd8\xff" + bytes(16)
    webp_header = b"RIFF" + bytes(4) + b"WEBP" + bytes(16)
    invalid_header = b"INVALID_HEADER_BYTES"

    assert sniff_image_ext(png_header) == ".png"
    assert sniff_image_ext(jpg_header) == ".jpg"
    assert sniff_image_ext(webp_header) == ".webp"
    assert sniff_image_ext(invalid_header) is None

    ogg_audio = b"OggS" + bytes(16)
    assert sniff_audio_ok(ogg_audio) is True
    assert sniff_audio_ok(invalid_header) is False

    webm_video = b"\x1a\x45\xdf\xa3" + bytes(16)
    assert sniff_video_ok(webm_video) is True
    assert sniff_video_ok(invalid_header) is False
