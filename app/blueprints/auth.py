"""Room create / join — exactly 2 members; hardened sessions (Production Ready)."""

from __future__ import annotations

import base64
import re
import secrets
import threading
from datetime import timedelta, timezone

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy import text

from app.auth_helpers import get_member_from_request, login_required, room_member_count
from app.crypto_utils import generate_member_token
from app.extensions import db
from app.models import Member, Room, User, utcnow
from app.security import rate_or_429, sanitize_display_name, validate_password

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_GENERIC_AUTH_FAIL = "Invalid Room ID or password"
_join_guard = threading.Lock()


@bp.post("/register")
def register():
    limited = rate_or_429("auth_register", *current_app.config["RL_AUTH"])
    if limited:
        return limited

    data = request.get_json(silent=True) or {}
    raw_id = data.get("identifier") or data.get("phone_number") or data.get("email")
    identifier, id_type = _normalize_identifier(raw_id)
    account_password = data.get("account_password") or data.get("password")
    display_name = sanitize_display_name(data.get("display_name") or "Partner") or "Partner"

    if not identifier:
        return jsonify({"error": "Enter a valid Phone number or Gmail/Email address"}), 400

    if not account_password or len(account_password) < current_app.config["MIN_PASSWORD_LENGTH"]:
        pass_err = validate_password(account_password, current_app.config["MIN_PASSWORD_LENGTH"])
        if pass_err:
            return jsonify({"error": pass_err}), 400

    existing_user = None
    if id_type == "email":
        existing_user = User.query.filter_by(email=identifier).first()
    else:
        existing_user = User.query.filter_by(phone_number=identifier).first()

    if existing_user:
        return jsonify({"error": "An account with this email/phone already exists. Please login."}), 409

    user = User(
        email=identifier if id_type == "email" else None,
        phone_number=identifier if id_type == "phone" else None,
        display_name=display_name,
        session_token=generate_member_token(),
    )
    user.set_password(account_password)
    db.session.add(user)
    db.session.commit()

    return jsonify({
        "ok": True,
        "message": "Account created successfully",
        "user_id": user.id,
        "display_name": user.display_name,
        "session_token": user.session_token,
    }), 201


def _begin_immediate() -> None:
    """SQLite write lock — serialize room membership changes to prevent race conditions."""
    try:
        db.session.execute(text("BEGIN IMMEDIATE"))
    except Exception:
        pass


def _normalize_identifier(value: object) -> tuple[str | None, str]:
    if not isinstance(value, str):
        return None, "invalid"
    v = value.strip()
    if "@" in v:
        # Email address
        if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", v):
            return v.lower(), "email"
        return None, "invalid"
    # Phone number
    compact = re.sub(r"[\s().-]", "", v)
    if compact.startswith("+"):
        compact = compact[1:]
    if compact.isascii() and compact.isdigit() and 7 <= len(compact) <= 15:
        return compact, "phone"
    return None, "invalid"


def _next_partner_name(members: list[Member], max_members: int) -> str:
    taken = {member.display_name for member in members}
    for slot in range(1, max_members + 1):
        candidate = f"Partner {slot}"
        if candidate not in taken:
            return candidate
    return f"Partner {len(members) + 1}"


def _member_session_expired(member: Member, now, idle_seconds: int) -> bool:
    last_seen = member.last_seen
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    return (now - last_seen).total_seconds() > idle_seconds


def _login_payload(room: Room, member: Member, phone_number: str, max_members: int):
    session["member_token"] = member.session_token
    return jsonify({
        "ok": True,
        "authenticated": True,
        "phone_number": phone_number,
        "room_id": room.room_id,
        "member_id": member.id,
        "display_name": member.display_name,
        "session_token": member.session_token,
        "salt": base64.b64encode(room.salt).decode("utf-8"),
        "slots_left": max(0, max_members - Member.query.filter_by(room_pk=room.id).count()),
        "theme_preset": room.theme_preset,
        "theme_url": "/api/theme/background" if room.theme_preset == "custom" else None,
        "theme_opacity": room.theme_opacity,
        "filmtv": room.filmtv_state(),
        "doodle_url": "/api/doodle/latest" if room.doodle_path else None,
    })


@bp.post("/login")
def login():
    limited = rate_or_429("auth_login", *current_app.config["RL_AUTH"])
    if limited:
        return limited

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "JSON object required"}), 400

    raw_id = data.get("identifier") or data.get("phone_number") or data.get("email")
    norm_id, id_type = _normalize_identifier(raw_id)
    if not norm_id:
        return jsonify({"error": "Enter a valid phone number (7-15 digits) or email address"}), 400

    phone_number = norm_id if id_type == "phone" else None
    password = data.get("password")
    legacy_room_id = data.get("legacy_room_id")
    resume_token = data.get("resume_token")

    if not isinstance(password, str) or not password or len(password) > 256:
        return jsonify({"error": "Room password is required"}), 400
    if legacy_room_id is not None and not isinstance(legacy_room_id, str):
        return jsonify({"error": "legacy_room_id must be a string"}), 400
    if resume_token is not None and not isinstance(resume_token, str):
        return jsonify({"error": "resume_token must be a string"}), 400

    with _join_guard:
        _begin_immediate()
        try:
            # Match by phone_number, email identifier, or legacy_room_id
            room = None
            if phone_number:
                room = Room.query.filter_by(phone_number=phone_number).first()
            if not room and id_type == "email":
                room = Room.query.filter_by(phone_number=norm_id).first()
            
            if room:
                if not room.check_password(password):
                    db.session.rollback()
                    return jsonify({"error": _GENERIC_AUTH_FAIL}), 403
            elif legacy_room_id:
                room = Room.query.filter_by(room_id=legacy_room_id.strip(), phone_number=None).first()
                if not room or not room.check_password(password):
                    db.session.rollback()
                    return jsonify({"error": _GENERIC_AUTH_FAIL}), 403
                room.phone_number = norm_id
                db.session.flush()
            else:
                password_error = validate_password(
                    password, current_app.config["MIN_PASSWORD_LENGTH"]
                )
                if password_error:
                    db.session.rollback()
                    return jsonify({"error": password_error}), 400
                room = Room(
                    room_id=f"account-{secrets.token_urlsafe(18)}",
                    phone_number=norm_id,
                    salt=secrets.token_bytes(16),
                    theme_opacity=0.92,
                )
                room.set_password(password)
                db.session.add(room)
                db.session.flush()

            max_members = current_app.config["MAX_ROOM_MEMBERS"]
            members = (
                Member.query.filter_by(room_pk=room.id)
                .order_by(Member.id.asc())
                .all()
            )
            now = utcnow()
            idle_seconds = current_app.config["SESSION_IDLE_RESUME_SECONDS"]

            matched_user = None
            if id_type == "email":
                matched_user = User.query.filter_by(email=norm_id).first()
            else:
                matched_user = User.query.filter_by(phone_number=norm_id).first()

            member = None
            if matched_user:
                member = Member.query.filter_by(room_pk=room.id, user_id=matched_user.id).first()

            if member is None and resume_token:
                member = Member.query.filter_by(room_pk=room.id, session_token=resume_token).first()

            if member is None:
                member = next(
                    (
                        item for item in members
                        if not item.session_token
                        or not item.is_online
                        or _member_session_expired(item, now, idle_seconds)
                    ),
                    None,
                )

            if member is None:
                if len(members) >= max_members:
                    db.session.rollback()
                    return jsonify({"error": "Private room already has two active members"}), 403

                chosen_name = matched_user.display_name if matched_user else _next_partner_name(members, max_members)
                taken_names = {m.display_name for m in members}
                if chosen_name in taken_names:
                    chosen_name = f"{chosen_name} {len(members) + 1}"

                member = Member(
                    room_pk=room.id,
                    display_name=chosen_name,
                    user_id=matched_user.id if matched_user else None,
                )
                db.session.add(member)

            if matched_user:
                member.user_id = matched_user.id
                if matched_user.display_name:
                    clash = Member.query.filter(
                        Member.room_pk == room.id,
                        Member.display_name == matched_user.display_name,
                        Member.id != member.id,
                    ).first()
                    if not clash:
                        member.display_name = matched_user.display_name

            member.session_token = generate_member_token()
            member.is_online = True
            member.last_seen = now
            db.session.commit()
        except Exception as e:
            current_app.logger.error("Login exception: %s", e, exc_info=True)
            db.session.rollback()
            return jsonify({"error": f"Could not log in: {e}"}), 409

    from app import sockets as socket_mod
    socket_mod.disconnect_member(member.id)
    return _login_payload(room, member, phone_number, max_members)


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
        "phone_number": room.phone_number,
        "room_id": room.room_id,
        "theme_preset": room.theme_preset,
        "theme_url": "/api/theme/background" if room.theme_preset == "custom" else None,
        "theme_opacity": room.theme_opacity,
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
            "phone_number": member.room.phone_number,
            "email": member.user.email if member.user else None,
            "room_id": member.room.room_id,
            "session_token": member.session_token,
            "salt": base64.b64encode(member.room.salt).decode("utf-8"),
            "theme_preset": member.room.theme_preset,
            "theme_url": "/api/theme/background" if member.room.theme_preset == "custom" else None,
            "theme_opacity": member.room.theme_opacity,
            "filmtv": member.room.filmtv_state(),
        }), 200
    except Exception:
        return jsonify({"authenticated": False}), 200