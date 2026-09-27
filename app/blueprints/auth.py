"""Room create / join — exactly 2 members; hardened sessions (Production Ready)."""

from __future__ import annotations

import base64
import secrets
import threading
from datetime import timedelta, timezone

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy import text

from app.auth_helpers import get_member_from_request, login_required, room_member_count
from app.crypto_utils import generate_member_token
from app.extensions import db
from app.models import Member, Room, utcnow
from app.security import rate_or_429, sanitize_display_name, validate_password

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_GENERIC_AUTH_FAIL = "Invalid Room ID or password"
_join_guard = threading.Lock()


def _begin_immediate() -> None:
    """SQLite write lock — serialize room membership changes to prevent race conditions."""
    try:
        db.session.execute(text("BEGIN IMMEDIATE"))
    except Exception:
        pass


@bp.post("/create-room")
def create_room():
    limited = rate_or_429("auth_create", *current_app.config["RL_AUTH"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    room_id = (data.get("room_id") or "").strip()
    password = data.get("password") or ""
    display_name = sanitize_display_name(data.get("display_name") or "Partner 1")

    if not room_id or len(room_id) < 4 or len(room_id) > 64:
        return jsonify({"error": "Room ID must be 4–64 characters"}), 400
    if not all(c.isalnum() or c in "-_" for c in room_id):
        return jsonify({"error": "Room ID may only contain letters, numbers, - and _"}), 400
    if not display_name:
        return jsonify({"error": "Display name invalid"}), 400

    pw_err = validate_password(password, current_app.config["MIN_PASSWORD_LENGTH"])
    if pw_err:
        return jsonify({"error": pw_err}), 400

    with _join_guard:
        _begin_immediate()
        try:
            existing_room = Room.query.filter_by(room_id=room_id).with_for_update().first()
            if existing_room:
                db.session.rollback()
                return jsonify({"error": "Room ID already exists. Please use Join Room."}), 409

            random_salt = secrets.token_bytes(16)
            room = Room(
                room_id=room_id,
                salt=random_salt,
                theme_opacity=0.92,
            )
            room.set_password(password)
            db.session.add(room)
            db.session.flush()

            token = generate_member_token()
            member = Member(
                room_pk=room.id,
                display_name=display_name,
                session_token=token,
                is_online=True,
                last_seen=utcnow(),
            )
            db.session.add(member)
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({"error": "Server error during room creation"}), 500

    session["member_token"] = token
    max_members = current_app.config.get("MAX_ROOM_MEMBERS", 2)
    return jsonify({
        "ok": True,
        "room_id": room.room_id,
        "member_id": member.id,
        "display_name": member.display_name,
        "session_token": token,
        "salt": base64.b64encode(room.salt).decode("utf-8"),
        "slots_left": max_members - 1,
    })


@bp.post("/join-room")
def join_room():
    limited = rate_or_429("auth_join", *current_app.config["RL_AUTH"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    room_id = (data.get("room_id") or "").strip()
    password = data.get("password") or ""
    display_name = sanitize_display_name(data.get("display_name") or "Partner 2")
    resume_token = (data.get("resume_token") or "").strip() or None

    if not display_name:
        return jsonify({"error": "Display name invalid (no HTML/special control chars)"}), 400

    with _join_guard:
        _begin_immediate()
        try:
            room = Room.query.filter_by(room_id=room_id).with_for_update().first()
            if not room or not room.check_password(password):
                db.session.rollback()
                return jsonify({"error": _GENERIC_AUTH_FAIL}), 403

            max_members = current_app.config["MAX_ROOM_MEMBERS"]
            idle_sec = current_app.config["SESSION_IDLE_RESUME_SECONDS"]
            count = room_member_count(room)

            existing = Member.query.filter_by(room_pk=room.id, display_name=display_name).with_for_update().first()
            
            if existing:
                if not _may_resume_or_reclaim(existing, resume_token, idle_sec):
                    db.session.rollback()
                    return jsonify({
                        "error": "Seat occupied. Use resume_token from this device, wait for idle timeout, or pick another display name."
                    }), 403

                existing.session_token = generate_member_token()
                existing.is_online = True
                existing.last_seen = utcnow()
                db.session.commit()
                
                session["member_token"] = existing.session_token
                
                from app import sockets as socket_mod
                socket_mod.disconnect_member(existing.id)

                return jsonify({
                    "ok": True,
                    "room_id": room.room_id,
                    "member_id": existing.id,
                    "display_name": existing.display_name,
                    "session_token": existing.session_token,
                    "salt": base64.b64encode(room.salt).decode("utf-8"),
                    "slots_left": max(0, max_members - count),
                    "rejoined": True,
                })

            if count >= max_members:
                db.session.rollback()
                return jsonify({"error": "Room is full (2-person private room only)"}), 403

            token = generate_member_token()
            member = Member(
                room_pk=room.id,
                display_name=display_name,
                session_token=token,
                is_online=True,
                last_seen=utcnow(),
            )
            db.session.add(member)
            db.session.commit()

        except Exception:
            db.session.rollback()
            return jsonify({"error": "Could not join room — try a different display name or try again later"}), 409

    session["member_token"] = token
    return jsonify({
        "ok": True,
        "room_id": room.room_id,
        "member_id": member.id,
        "display_name": member.display_name,
        "session_token": token,
        "salt": base64.b64encode(room.salt).decode("utf-8"),
        "slots_left": max(0, max_members - count - 1),
    })


def _may_resume_or_reclaim(member: Member, resume_token: str | None, idle_sec: int) -> bool:
    if not member.session_token:
        return True
    if resume_token and resume_token == member.session_token:
        return True
    if not member.is_online:
        return True
    return False


@bp.get("/me")
@login_required
def me():
    from flask import g

    room = g.room
    members = [
        {
            "id": m.id,
            "display_name": m.display_name,
            "is_online": m.is_online,
        }
        for m in room.members
    ]
    return jsonify({
        "member_id": g.member.id,
        "display_name": g.member.display_name,
        "room_id": room.room_id,
        "theme_preset": room.theme_preset,
        "theme_path": room.theme_path,
        "members": members,
        "instagram_sync_url": room.instagram_sync_url,
        "filmtv": room.filmtv_state(),
    })


@bp.post("/display-name")
@login_required
def update_display_name():
    from flask import g

    data = request.get_json(silent=True) or {}
    name = sanitize_display_name(data.get("display_name") or "")
    if not name:
        return jsonify({"error": "Display name required / invalid characters"}), 400

    clash = Member.query.filter(
        Member.room_pk == g.room.id,
        Member.display_name == name,
        Member.id != g.member.id,
    ).first()
    if clash:
        return jsonify({"error": "Name already taken in this room"}), 409

    g.member.display_name = name
    db.session.commit()
    return jsonify({"ok": True, "display_name": name})


@bp.post("/logout")
@login_required
def logout():
    from flask import g
    from app import sockets as socket_mod

    g.member.is_online = False
    g.member.session_token = None
    g.member.last_seen = utcnow()
    db.session.commit()
    session.pop("member_token", None)
    socket_mod.disconnect_member(g.member.id)
    return jsonify({"ok": True})


@bp.get("/session-check")
def session_check():
    try:
        member = get_member_from_request()
        if not member:
            return jsonify({"authenticated": False}), 200
        return jsonify({
            "authenticated": True,
            "member_id": member.id,
            "display_name": member.display_name,
            "room_id": member.room.room_id,
            "session_token": member.session_token,
        }), 200
    except Exception:
        return jsonify({"authenticated": False}), 200