"""Messages, media, themes, FilmTV — hardened uploads & rate limits."""

from __future__ import annotations

import os
import uuid
import zipfile
import hashlib
import math
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from flask import Blueprint, Response, current_app, g, jsonify, request, send_file, url_for
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.orm import joinedload
from werkzeug.utils import secure_filename

from app.auth_helpers import login_required, get_member_from_request
from app.extensions import db, socketio
from app.models import FilmTVAnnotation, Member, Message, Room, utcnow
from app.security import (
    rate_or_429,
    read_upload_header,
    sanitize_instagram_url,
    sniff_audio_ok,
    sniff_image_ext,
    sniff_video_ok,
    validate_direct_video_url,
)

import logging

bp = Blueprint("api", __name__, url_prefix="/api")

logger = logging.getLogger(__name__)



def _purge_expired(room_pk: int) -> list[int]:
    now = utcnow()
    expired = Message.query.filter(
        Message.room_pk == room_pk,
        Message.deleted.is_(False),
        Message.expires_at.isnot(None),
        Message.expires_at <= now,
    ).all()
    ids = []
    for msg in expired:
        msg.deleted = True
        if msg.media_path:
            try:
                Path(msg.media_path).unlink(missing_ok=True)
            except OSError:
                pass
            msg.media_path = None
        ids.append(msg.id)
    if ids:
        db.session.commit()
    return ids


def _ciphertext_ok(ciphertext: str | None) -> tuple[bool, str | None]:
    if ciphertext is None:
        return False, "ciphertext required"
    if not isinstance(ciphertext, str):
        return False, "ciphertext must be a string"
    max_chars = current_app.config["MAX_CIPHERTEXT_CHARS"]
    if len(ciphertext) > max_chars:
        return False, f"ciphertext exceeds {max_chars} characters"
    return True, None


def _ttl_from(value) -> tuple[object | None, str | None]:
    if value is None or value == "":
        return None, None
    try:
        ttl = int(value)
    except (TypeError, ValueError):
        return None, "invalid ttl_seconds"
    if ttl <= 0:
        return None, None
    if ttl > 7 * 24 * 3600:
        return None, "ttl_seconds too large"
    return utcnow() + timedelta(seconds=ttl), None


def _filmtv_upload_path(source: str | None) -> Path | None:
    if not source:
        return None
    uploads = Path(current_app.config["FILMTV_DIR"]).resolve()
    path = Path(source).resolve()
    try:
        path.relative_to(uploads)
    except ValueError:
        return None
    return path


def _active_pdf_document_key(room) -> str | None:
    if room.filmtv_source_type != "upload":
        return None
    path = _filmtv_upload_path(room.filmtv_source)
    if not path or not path.is_file() or path.suffix.lower() != ".pdf":
        return None
    return hashlib.sha256(f"{room.id}:{path.name}".encode("utf-8")).hexdigest()


def _annotation_payload(annotation: FilmTVAnnotation) -> dict:
    return {
        "id": annotation.id,
        "document_key": annotation.document_key,
        "page_number": annotation.page_number,
        "kind": annotation.kind,
        "x": annotation.x,
        "y": annotation.y,
        "width": annotation.width,
        "height": annotation.height,
        "color": annotation.color,
        "created_by": annotation.created_by,
        "created_at": annotation.created_at.isoformat(),
    }


def _remove_filmtv_upload(source: str | None) -> None:
    path = _filmtv_upload_path(source)
    if path:
        try:
            path.unlink(missing_ok=True)
        except PermissionError:
            return
        except OSError:
            logger.warning("Failed to remove old FilmTV upload: %s", path)


def _valid_filmtv_upload(ext: str, header: bytes, file_storage) -> bool:
    if ext in current_app.config["ALLOWED_VIDEO_EXT"]:
        if not sniff_video_ok(header):
            return False
        if ext in {".mp4", ".mov", ".m4v"}:
            return len(header) >= 8 and header[4:8] == b"ftyp"
        if ext in {".webm", ".mkv"}:
            return header.startswith(b"\x1a\x45\xdf\xa3")
        return header.startswith(b"OggS")
    if ext == ".pdf":
        return header.startswith(b"%PDF-")
    if ext in {".doc", ".xls", ".ppt"}:
        return header.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if ext in {".docx", ".xlsx", ".pptx"}:
        expected = {
            ".docx": "word/document.xml",
            ".xlsx": "xl/workbook.xml",
            ".pptx": "ppt/presentation.xml",
        }[ext]
        try:
            file_storage.stream.seek(0)
            with zipfile.ZipFile(file_storage.stream) as archive:
                names = set(archive.namelist())
                return "[Content_Types].xml" in names and expected in names
        except (OSError, zipfile.BadZipFile):
            return False
        finally:
            file_storage.stream.seek(0)
    if ext == ".txt":
        return b"\x00" not in header
    return False


def _upload_request_too_large(max_file_bytes: int):
    request_limit = max_file_bytes + 1024 * 1024
    if request.content_length is not None and request.content_length > request_limit:
        return jsonify({"error": "Request exceeds the upload limit."}), 413
    return None


@bp.get("/messages")
@login_required
def list_messages():
    limited = rate_or_429("messages_list", *current_app.config["RL_MESSAGES"])
    if limited:
        return limited

    purged = _purge_expired(g.room.id)
    if purged:
        socketio.emit(
            "messages_expired",
            {"ids": purged},
            room=f"room:{g.room.room_id}",
        )

    rows = (
        Message.query.options(joinedload(Message.sender))
        .filter_by(room_pk=g.room.id, deleted=False)
        .order_by(Message.created_at.asc())
        .limit(500)
        .all()
    )
    out = []
    for m in rows:
        if m.is_expired():
            continue
        out.append(
            {
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_name": m.sender.display_name if m.sender else "Partner",
                "sender_avatar_url": f"/api/profile/avatar/{m.sender_id}",
                "ciphertext": m.ciphertext,
                "msg_type": m.msg_type,
                "media_url": f"/api/media/{m.id}" if m.media_path else None,
                "media_mime": m.media_mime,
                "created_at": m.created_at.isoformat(),
                "expires_at": m.expires_at.isoformat() if m.expires_at else None,
            }
        )
    return jsonify({"messages": out})


@bp.post("/messages")
@login_required
def post_message():
    limited = rate_or_429("messages_post", *current_app.config["RL_MESSAGES"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    ciphertext = data.get("ciphertext")
    msg_type = data.get("msg_type", "text")
    ttl_seconds = data.get("ttl_seconds")

    ok, err = _ciphertext_ok(ciphertext)
    if not ok:
        return jsonify({"error": err}), 400
    if msg_type not in ("text", "image", "voice", "system"):
        return jsonify({"error": "invalid msg_type"}), 400

    expires_at, ttl_err = _ttl_from(ttl_seconds)
    if ttl_err:
        return jsonify({"error": ttl_err}), 400

    msg = Message(
        room_pk=g.room.id,
        sender_id=g.member.id,
        ciphertext=ciphertext,
        msg_type=msg_type,
        expires_at=expires_at,
    )
    db.session.add(msg)
    db.session.commit()

    payload = {
        "id": msg.id,
        "sender_id": g.member.id,
        "sender_name": g.member.display_name,
        "sender_avatar_url": f"/api/profile/avatar/{g.member.id}",
        "ciphertext": msg.ciphertext,
        "msg_type": msg.msg_type,
        "media_url": None,
        "media_mime": None,
        "created_at": msg.created_at.isoformat(),
        "expires_at": msg.expires_at.isoformat() if msg.expires_at else None,
    }
    socketio.emit("new_message", payload, room=f"room:{g.room.room_id}")
    return jsonify({"ok": True, "message": payload})


@bp.post("/media")
@login_required
def upload_media():
    """Accept encrypted media blob + ciphertext caption; store locally."""
    limited = rate_or_429("media_upload", *current_app.config["RL_UPLOAD"])
    if limited:
        return limited
    too_large = _upload_request_too_large(current_app.config["CHAT_MEDIA_MAX_BYTES"])
    if too_large:
        return too_large

    if "file" not in request.files:
        return jsonify({"error": "file required"}), 400

    f = request.files["file"]
    ciphertext = request.form.get("ciphertext") or ""
    msg_type = request.form.get("msg_type", "image")
    media_mime = request.form.get("media_mime") or f.mimetype or "application/octet-stream"
    ttl_seconds = request.form.get("ttl_seconds")

    if msg_type not in ("image", "voice"):
        return jsonify({"error": "msg_type must be image or voice"}), 400

    ok, err = _ciphertext_ok(ciphertext if ciphertext else "media")
    if not ok:
        return jsonify({"error": err}), 400

    original = secure_filename(f.filename or "upload.bin")
    ext = Path(original).suffix.lower() or ".bin"
    allowed = current_app.config["ALLOWED_IMAGE_EXT"] | current_app.config["ALLOWED_AUDIO_EXT"] | {
        ".bin",
        ".enc",
    }
    if ext not in allowed:
        return jsonify({"error": "file type not allowed"}), 400

    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(0)
    if size <= 0 or size > current_app.config["CHAT_MEDIA_MAX_BYTES"]:
        return jsonify({"error": "file too large or empty"}), 400

    if ext not in {".bin", ".enc"}:
        header = read_upload_header(f, 32)
        if msg_type == "image" and not sniff_image_ext(header):
            return jsonify({"error": "file content is not a valid image"}), 400
        if msg_type == "voice" and not sniff_audio_ok(header):
            return jsonify({"error": "file content is not a valid audio container"}), 400

    filename = f"{g.room.room_id}_{uuid.uuid4().hex}{ext}"
    dest = Path(current_app.config["UPLOADS_DIR"]) / filename
    f.save(dest)

    expires_at, _ = _ttl_from(ttl_seconds)

    msg = Message(
        room_pk=g.room.id,
        sender_id=g.member.id,
        ciphertext=ciphertext or "media",
        msg_type=msg_type,
        media_path=str(dest),
        media_mime=media_mime[:128],
        expires_at=expires_at,
    )
    db.session.add(msg)
    db.session.commit()

    payload = {
        "id": msg.id,
        "sender_id": g.member.id,
        "sender_name": g.member.display_name,
        "ciphertext": msg.ciphertext,
        "msg_type": msg.msg_type,
        "media_url": f"/api/media/{msg.id}",
        "media_mime": msg.media_mime,
        "created_at": msg.created_at.isoformat(),
        "expires_at": msg.expires_at.isoformat() if msg.expires_at else None,
    }
    socketio.emit("new_message", payload, room=f"room:{g.room.room_id}")
    return jsonify({"ok": True, "message": payload})


@bp.get("/media/<int:message_id>")
@login_required
def get_media(message_id: int):
    msg = Message.query.filter_by(id=message_id, room_pk=g.room.id, deleted=False).first()
    if not msg or not msg.media_path or msg.is_expired():
        return jsonify({"error": "not found"}), 404
    if not os.path.isfile(msg.media_path):
        return jsonify({"error": "file missing"}), 404
    uploads = Path(current_app.config["UPLOADS_DIR"]).resolve()
    try:
        Path(msg.media_path).resolve().relative_to(uploads)
    except ValueError:
        return jsonify({"error": "not found"}), 404
    return send_file(msg.media_path, mimetype=msg.media_mime or "application/octet-stream")


@bp.post("/theme")
@login_required
def set_theme():
    limited = rate_or_429("theme", *current_app.config["RL_UPLOAD"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    preset = (data.get("theme_preset") or "").strip()
    custom_url = (data.get("custom_url") or "").strip()
    opacity = data.get("opacity")
    allowed = {"blush", "midnight", "forest", "sand", "lavender", "crimson", "ocean", "emerald", "cyberpunk", "custom"}

    if preset and preset not in allowed:
        return jsonify({"error": "invalid theme_preset"}), 400

    if preset:
        g.room.theme_preset = preset[:64]
    if preset == "custom" and custom_url:
        g.room.theme_path = custom_url[:2048]

    if opacity is not None:
        try:
            g.room.theme_opacity = float(opacity)
        except (TypeError, ValueError):
            pass

    db.session.commit()
    url = g.room.theme_path if g.room.theme_preset == "custom" else "/api/theme/background"
    socketio.emit(
        "theme_updated",
        {
            "theme_preset": g.room.theme_preset,
            "theme_url": url,
            "theme_opacity": getattr(g.room, "theme_opacity", 0.92),
        },
        room=f"room:{g.room.room_id}",
    )
    return jsonify(
        {
            "ok": True,
            "theme_preset": g.room.theme_preset,
            "theme_opacity": getattr(g.room, "theme_opacity", 0.92),
        }
    )


@bp.get("/theme/search")
@login_required
def search_unsplash():
    query = request.args.get("query", "").strip()
    if not query:
        return jsonify({"results": []})
    
    key = os.environ.get("UNSPLASH_API_KEY")
    if not key:
        results = []
        import random
        for _ in range(9):
            sig = random.randint(1000, 9999)
            results.append({
                "id": str(sig),
                "urls": {
                    "thumb": f"https://source.unsplash.com/featured/200x200?{query}&sig={sig}",
                    "regular": f"https://source.unsplash.com/featured/1200x800?{query}&sig={sig}"
                }
            })
        return jsonify({"results": results})

    import requests
    try:
        res = requests.get(
            "https://api.unsplash.com/search/photos",
            params={"query": query, "per_page": 12},
            headers={"Authorization": f"Client-ID {key}"},
            timeout=10
        )
        res.raise_for_status()
        data = res.json()
        return jsonify({"results": data.get("results", [])})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.post("/theme/upload")
@login_required
def upload_theme():
    limited = rate_or_429("theme_upload", *current_app.config["RL_UPLOAD"])
    if limited:
        return limited
    too_large = _upload_request_too_large(current_app.config["THEME_MAX_BYTES"])
    if too_large:
        return too_large

    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded"}), 400

    original = secure_filename(f.filename or "theme.jpg")
    ext = Path(original).suffix.lower()
    if ext not in current_app.config["ALLOWED_IMAGE_EXT"]:
        return jsonify({"error": f"File type not allowed: {ext}"}), 400

    header = read_upload_header(f, 32)
    sniffed = sniff_image_ext(header)
    if not sniffed:
        return jsonify({"error": "File content is not a valid image"}), 400

    if sniffed == ".jpg" and ext not in {".jpg", ".jpeg"}:
        ext = ".jpg"
    elif sniffed != ext:
        ext = sniffed

    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(0)
    if size <= 0 or size > current_app.config["THEME_MAX_BYTES"]:
        return jsonify({"error": "Theme image too large (max 8MB)"}), 400

    filename = f"theme_{g.room.room_id}_{uuid.uuid4().hex}{ext}"
    dest = Path(current_app.config["THEMES_DIR"]) / filename
    try:
        f.save(dest)
    except Exception as e:
        return jsonify({"error": f"Failed to save file: {str(e)}"}), 500

    if g.room.theme_path and os.path.exists(g.room.theme_path) and "theme_" in g.room.theme_path:
        try:
            Path(g.room.theme_path).unlink(missing_ok=True)
        except OSError:
            pass

    g.room.theme_path = str(dest)
    g.room.theme_preset = "custom"
    db.session.commit()

    url = "/api/theme/background"
    socketio.emit(
        "theme_updated",
        {
            "theme_preset": "custom",
            "theme_url": url,
            "theme_opacity": getattr(g.room, "theme_opacity", 0.92),
        },
        room=f"room:{g.room.room_id}",
    )
    return jsonify(
        {
            "ok": True,
            "theme_url": url,
            "theme_preset": "custom",
            "theme_opacity": getattr(g.room, "theme_opacity", 0.92),
        }
    )


@bp.get("/theme/background")
@login_required
def theme_background():
    if g.room.theme_path and os.path.isfile(g.room.theme_path):
        themes = Path(current_app.config["THEMES_DIR"]).resolve()
        try:
            Path(g.room.theme_path).resolve().relative_to(themes)
            return send_file(g.room.theme_path)
        except ValueError:
            pass
    
    # 1x1 transparent fallback PNG to prevent 404 console errors when custom background is unset
    fallback_png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
        b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    return Response(fallback_png, mimetype="image/png", status=200)


@bp.post("/profile/avatar")
@login_required
def upload_avatar():
    if "file" not in request.files:
        return jsonify({"error": "file field required"}), 400
    f = request.files["file"]
    if not f or not f.filename:
        return jsonify({"error": "empty file"}), 400

    header = read_upload_header(f)
    ext = sniff_image_ext(header)
    if not ext:
        return jsonify({"error": "Invalid image format (PNG, JPG, WEBP, GIF required)"}), 400

    avatars_dir = Path(current_app.config["MEDIA_DIR"]) / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    filename = f"avatar_member_{g.member.id}_{uuid.uuid4().hex}{ext}"
    dest = avatars_dir / filename
    f.save(dest)

    if g.member.avatar_path:
        try:
            Path(g.member.avatar_path).unlink(missing_ok=True)
        except OSError:
            pass

    g.member.avatar_path = str(dest)
    if g.member.user:
        g.member.user.avatar_path = str(dest)

    db.session.commit()

    avatar_url = f"/api/profile/avatar/{g.member.id}"
    socketio.emit(
        "avatar_updated",
        {"member_id": g.member.id, "display_name": g.member.display_name, "avatar_url": avatar_url},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "avatar_url": avatar_url})


@bp.get("/profile/avatar")
@bp.get("/profile/avatar/<int:member_id>")
def get_avatar(member_id: int | None = None):
    target_member = None
    if member_id is not None:
        target_member = Member.query.get(member_id)
    else:
        target_member = get_member_from_request()

    if target_member and target_member.avatar_path and os.path.isfile(target_member.avatar_path):
        try:
            return send_file(target_member.avatar_path)
        except Exception:
            pass

    default_avatar_svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        '<rect width="128" height="128" fill="#121826"/>'
        '<circle cx="64" cy="48" r="28" fill="#ff8fab"/>'
        '<path d="M20,112 C20,88 40,76 64,76 C88,76 108,88 108,112 Z" fill="#ff8fab"/>'
        '</svg>'
    )
    return Response(default_avatar_svg, mimetype="image/svg+xml", status=200)


@bp.post("/instagram/session")
@login_required
def save_instagram_session():
    limited = rate_or_429("ig_session", *current_app.config["RL_UPLOAD"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    enc = data.get("session_ciphertext")
    ok, err = _ciphertext_ok(enc)
    if not ok:
        return jsonify({"error": err}), 400
    g.room.instagram_session_enc = enc
    db.session.commit()
    socketio.emit(
        "instagram_session_ready",
        {"ready": True},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True})


@bp.get("/instagram/session")
@login_required
def get_instagram_session():
    return jsonify({"session_ciphertext": g.room.instagram_session_enc})


@bp.post("/instagram/sync")
@login_required
def sync_instagram_url():
    limited = rate_or_429("ig_sync", *current_app.config["RL_MESSAGES"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    raw = (data.get("url") or "").strip()
    if not raw:
        g.room.instagram_sync_url = None
        db.session.commit()
        socketio.emit(
            "instagram_sync",
            {"url": "", "by": g.member.display_name},
            room=f"room:{g.room.room_id}",
        )
        return jsonify({"ok": True, "url": ""})

    url = sanitize_instagram_url(raw)
    if not url:
        return jsonify({"error": "Only https://www.instagram.com/(p|reel|tv)/… URLs allowed"}), 400

    g.room.instagram_sync_url = url
    db.session.commit()
    socketio.emit(
        "instagram_sync",
        {"url": url, "by": g.member.display_name},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "url": url})


@bp.post("/doodle/save")
@login_required
def save_doodle():
    limited = rate_or_429("doodle", *current_app.config["RL_UPLOAD"])
    if limited:
        return limited
    too_large = _upload_request_too_large(current_app.config["DOODLE_MAX_BYTES"])
    if too_large:
        return too_large

    if "file" not in request.files:
        return jsonify({"error": "file required"}), 400
    f = request.files["file"]
    header = read_upload_header(f, 8)
    if not header.startswith(b"\x89PNG\r\n\x1a\n"):
        return jsonify({"error": "doodle must be a valid PNG"}), 400

    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(0)
    if size <= 8 or size > current_app.config["DOODLE_MAX_BYTES"]:
        return jsonify({"error": "doodle too large or empty"}), 400

    filename = f"doodle_{g.room.room_id}_{uuid.uuid4().hex}.png"
    dest = Path(current_app.config["DOODLES_DIR"]) / filename
    f.save(dest)
    if g.room.doodle_path:
        try:
            Path(g.room.doodle_path).unlink(missing_ok=True)
        except OSError:
            pass
    g.room.doodle_path = str(dest)
    db.session.commit()
    socketio.emit(
        "doodle_saved",
        {"url": "/api/doodle/latest"},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "url": "/api/doodle/latest"})


@bp.get("/doodle/latest")
@login_required
def get_doodle():
    if g.room.doodle_path and os.path.isfile(g.room.doodle_path):
        doodles = Path(current_app.config["DOODLES_DIR"]).resolve()
        try:
            Path(g.room.doodle_path).resolve().relative_to(doodles)
            return send_file(g.room.doodle_path, mimetype="image/png")
        except ValueError:
            pass
    fallback_png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
        b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    return Response(fallback_png, mimetype="image/png", status=200)


# ─── FilmTV Watch Party (native HTML5 only) ─────────────────────────


@bp.get("/filmtv/state")
@login_required
def filmtv_state():
    try:
        if g.room.filmtv_source_type == "youtube":
            g.room.filmtv_source_type = "url"
            db.session.commit()
            
        return jsonify({"ok": True, "state": g.room.filmtv_state()})
    except Exception as e:
        logger.error(f"Error fetching filmtv state: {e}")
        return jsonify({"error": "Failed to fetch state"}), 500


@bp.post("/filmtv/source")
@bp.post("/filmtv/load")
@login_required
def filmtv_load():
    """Load a shared URL (video, doc, or app) into the workspace with auto YouTube embedding conversion."""
    limited = rate_or_429("filmtv_load", *current_app.config["RL_FILMTV"])
    if limited:
        return limited

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "JSON object required"}), 400
    raw_url = data.get("source") or data.get("url") or ""
    raw_title = data.get("title") or ""
    if not isinstance(raw_url, str) or not isinstance(raw_title, str):
        return jsonify({"error": "source and title must be strings"}), 400
    url = raw_url.strip()
    title = raw_title.strip()[:256] or "Shared Workspace"

    if not url:
        return jsonify({"error": "url required"}), 400

    if len(url) > 2048:
        return jsonify({"error": "URL is too long"}), 400
    try:
        parsed = urlsplit(url)
    except ValueError:
        return jsonify({"error": "Invalid URL"}), 400
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        return jsonify({"error": "Only HTTPS URLs are allowed for security"}), 400

    host = parsed.hostname.lower().rstrip(".")
    video_id = None
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com"} and parsed.path == "/watch":
        video_id = parse_qs(parsed.query).get("v", [None])[0]
    elif host == "youtu.be":
        video_id = parsed.path.strip("/").split("/", 1)[0]
    if video_id:
        url = f"https://www.youtube.com/embed/{quote(video_id, safe='')}"

    old_source = g.room.filmtv_source if g.room.filmtv_source_type == "upload" else None
    g.room.filmtv_source_type = "url"
    g.room.filmtv_source = url
    g.room.filmtv_title = title
    g.room.filmtv_playing = False
    g.room.filmtv_position = 0.0
    g.room.filmtv_host_id = g.member.id
    g.room.filmtv_updated_at = utcnow()
    db.session.commit()
    _remove_filmtv_upload(old_source)

    state = g.room.filmtv_state()
    socketio.emit(
        "filmtv_state",
        {"state": state, "by": g.member.display_name, "action": "load"},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "state": state})


@bp.post("/filmtv/upload")
@login_required
def filmtv_upload():
    """Upload a local movie/video or document for shared playback."""
    limited = rate_or_429("filmtv_upload", *current_app.config["RL_UPLOAD"])
    if limited:
        return limited
    too_large = _upload_request_too_large(current_app.config["FILMTV_MAX_BYTES"])
    if too_large:
        return too_large

    try:
        if "file" not in request.files:
            return jsonify({"error": "file required"}), 400
        
        f = request.files["file"]
        if not f or not f.filename:
            return jsonify({"error": "empty file"}), 400

        original = secure_filename(f.filename or "file.dat")
        ext = Path(original).suffix.lower()
        
        allowed_all = current_app.config["ALLOWED_VIDEO_EXT"] | current_app.config["ALLOWED_DOC_EXT"]
        if ext not in allowed_all:
            return jsonify({"error": f"file type not allowed ({ext})"}), 400

        header = read_upload_header(f, 32)
        
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(0)
        if size <= 0 or size > current_app.config["FILMTV_MAX_BYTES"]:
            return jsonify({"error": "file too large or empty"}), 400

        if not _valid_filmtv_upload(ext, header, f):
            return jsonify({"error": "file content does not match its extension"}), 400

        old_source = g.room.filmtv_source if g.room.filmtv_source_type == "upload" else None

        filename = f"filmtv_{g.room.room_id}_{uuid.uuid4().hex}{ext}"
        dest = Path(current_app.config["FILMTV_DIR"]) / filename
        
        f.save(str(dest))

        g.room.filmtv_source_type = "upload"
        g.room.filmtv_source = str(dest)
        g.room.filmtv_title = (request.form.get("title") or original)[:256]
        g.room.filmtv_playing = False
        g.room.filmtv_position = 0.0
        g.room.filmtv_host_id = g.member.id
        g.room.filmtv_updated_at = utcnow()
        
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            dest.unlink(missing_ok=True)
            raise

        _remove_filmtv_upload(old_source)

        state = g.room.filmtv_state()
        socketio.emit(
            "filmtv_state",
            {"state": state, "by": g.member.display_name, "action": "load"},
            room=f"room:{g.room.room_id}",
        )
        return jsonify({"ok": True, "state": state})

    except Exception as e:
        logger.exception("Error in filmtv_upload")
        db.session.rollback()
        return jsonify({"error": "Internal server error during upload"}), 500


@bp.get("/filmtv/view-ticket")
@login_required
def filmtv_view_ticket():
    if g.room.filmtv_source_type != "upload" or not _filmtv_upload_path(g.room.filmtv_source):
        return jsonify({"error": "no uploaded document"}), 404
    serializer = URLSafeTimedSerializer(current_app.secret_key, salt="filmtv-stream")
    ticket = serializer.dumps(
        {"room_id": g.room.id, "filename": Path(g.room.filmtv_source).name}
    )
    return jsonify({"stream_url": url_for("api.filmtv_stream", ticket=ticket)})


@bp.get("/filmtv/annotations")
@login_required
def filmtv_get_annotations():
    document_key = _active_pdf_document_key(g.room)
    if not document_key:
        return jsonify({"error": "An uploaded PDF must be active"}), 404
    rows = (
        FilmTVAnnotation.query.filter_by(room_pk=g.room.id, document_key=document_key)
        .order_by(FilmTVAnnotation.page_number, FilmTVAnnotation.created_at)
        .limit(10000)
        .all()
    )
    return jsonify({"document_key": document_key, "annotations": [_annotation_payload(row) for row in rows]})


@bp.post("/filmtv/annotations")
@login_required
def filmtv_add_annotation():
    limited = rate_or_429("filmtv_annotation", *current_app.config["RL_SOCKET"])
    if limited:
        return limited
    document_key = _active_pdf_document_key(g.room)
    if not document_key:
        return jsonify({"error": "An uploaded PDF must be active"}), 404
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "JSON object required"}), 400
    kind = data.get("kind")
    color = data.get("color", "yellow")
    if not isinstance(kind, str) or kind not in {"highlight", "underline"}:
        return jsonify({"error": "kind must be highlight or underline"}), 400
    colors = {"yellow", "green", "blue", "pink"}
    if not isinstance(color, str) or color not in colors:
        return jsonify({"error": "unsupported annotation color"}), 400
    try:
        page_number = data.get("page_number")
        if type(page_number) is not int:
            raise ValueError
        coords = {key: float(data.get(key)) for key in ("x", "y", "width", "height")}
    except (TypeError, ValueError):
        return jsonify({"error": "page and annotation coordinates must be numbers"}), 400
    if page_number < 1 or page_number > 100000:
        return jsonify({"error": "page_number is out of range"}), 400
    if any(not math.isfinite(value) for value in coords.values()):
        return jsonify({"error": "annotation coordinates must be finite"}), 400
    x, y, width, height = (coords[key] for key in ("x", "y", "width", "height"))
    if (
        x < 0 or y < 0 or width <= 0 or height <= 0
        or x + width > 1 or y + height > 1
    ):
        return jsonify({"error": "annotation must fit within the page"}), 400

    annotation = FilmTVAnnotation(
        room_pk=g.room.id,
        document_key=document_key,
        page_number=page_number,
        kind=kind,
        x=x,
        y=y,
        width=width,
        height=height,
        color=color,
        created_by=g.member.id,
    )
    db.session.add(annotation)
    db.session.commit()
    payload = _annotation_payload(annotation)
    socketio.emit(
        "filmtv_annotation_added",
        payload,
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "annotation": payload}), 201


@bp.delete("/filmtv/annotations")
@login_required
def filmtv_clear_annotations():
    document_key = _active_pdf_document_key(g.room)
    if not document_key:
        return jsonify({"error": "An uploaded PDF must be active"}), 404
    FilmTVAnnotation.query.filter_by(room_pk=g.room.id, document_key=document_key).delete(
        synchronize_session=False
    )
    db.session.commit()
    socketio.emit(
        "filmtv_annotations_cleared",
        {"document_key": document_key},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "document_key": document_key})


@bp.get("/filmtv/stream")
def filmtv_stream():
    """Stream an upload with byte ranges; external viewers use short-lived scoped tickets."""
    ticket = request.args.get("ticket")
    room = None
    if ticket:
        serializer = URLSafeTimedSerializer(current_app.secret_key, salt="filmtv-stream")
        try:
            payload = serializer.loads(ticket, max_age=3600)
        except BadSignature:
            return jsonify({"error": "Invalid or expired stream ticket"}), 401
        room = Room.query.get(payload.get("room_id"))
        if (
            not room
            or room.filmtv_source_type != "upload"
            or not room.filmtv_source
            or Path(room.filmtv_source).name != payload.get("filename")
        ):
            return jsonify({"error": "Stream is no longer available"}), 404
    else:
        member = get_member_from_request(allow_query_token=False)
        if not member:
            return jsonify({"error": "Unauthorized stream request"}), 401
        room = member.room

    try:
        if room.filmtv_source_type != "upload" or not room.filmtv_source:
            return jsonify({"error": "no uploaded video/document"}), 404
        file_path = _filmtv_upload_path(room.filmtv_source)
        if not file_path:
            return jsonify({"error": "Unauthorized path"}), 403
        if not file_path.is_file():
            logger.error(f"FilmTV file missing on disk: {file_path}")
            return jsonify({"error": "File not found"}), 404
            
        return send_file(str(file_path), conditional=True)
    except Exception as e:
        logger.error(f"Streaming error: {e}")
        return jsonify({"error": "Streaming failed"}), 500


@bp.post("/filmtv/clear")
@login_required
def filmtv_clear():
    limited = rate_or_429("filmtv_clear", *current_app.config["RL_FILMTV"])
    if limited:
        return limited

    old_source = g.room.filmtv_source if g.room.filmtv_source_type == "upload" else None
    g.room.filmtv_source_type = None
    g.room.filmtv_source = None
    g.room.filmtv_title = None
    g.room.filmtv_playing = False
    g.room.filmtv_position = 0.0
    g.room.filmtv_host_id = None
    g.room.filmtv_updated_at = utcnow()
    db.session.commit()
    _remove_filmtv_upload(old_source)
    state = g.room.filmtv_state()
    socketio.emit(
        "filmtv_state",
        {"state": state, "by": g.member.display_name, "action": "clear"},
        room=f"room:{g.room.room_id}",
    )
    return jsonify({"ok": True, "state": state})


@bp.get("/gallery")
@login_required
def list_gallery():
    """Fetch all non-expired media history for the room."""
    rows = (
        Message.query.options(joinedload(Message.sender))
        .filter(
            Message.room_pk == g.room.id,
            Message.deleted.is_(False),
            Message.media_path.isnot(None),
        )
        .order_by(Message.created_at.desc())
        .all()
    )
    out = []
    for m in rows:
        if m.is_expired():
            continue
        out.append(
            {
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_name": m.sender.display_name if m.sender else "Partner",
                "msg_type": m.msg_type,
                "media_url": f"/api/media/{m.id}",
                "media_mime": m.media_mime,
                "created_at": m.created_at.isoformat(),
            }
        )
    return jsonify({"gallery": out})


@bp.route("/export", methods=["GET", "POST"])
@bp.route("/messages/export", methods=["GET", "POST"])
@bp.route("/history/export", methods=["GET", "POST"])
@login_required
def export_blocked():
    return jsonify({"error": "Chat history export is permanently disabled for privacy."}), 403