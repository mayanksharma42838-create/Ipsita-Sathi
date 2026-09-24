import os

# 1. Fixed auth.py code (Handles 409 conflict & duplicate name smoothly)
AUTH_CODE = '''"""Room create / join — exactly 2 members per Shared Room ID + Secret Password."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request, session

from app.auth_helpers import get_member_from_request, login_required, room_member_count
from app.crypto_utils import generate_member_token
from app.extensions import db
from app.models import Member, Room, utcnow

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@bp.post("/create-room")
def create_room():
    data = request.get_json(silent=True) or {}
    room_id = (data.get("room_id") or "").strip()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or "Partner 1").strip()[:64]

    if not room_id or len(room_id) < 4:
        return jsonify({"error": "Room ID must be at least 4 characters"}), 400
    if not password or len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    existing_room = Room.query.filter_by(room_id=room_id).first()
    if existing_room:
        return jsonify({"error": "Room ID already exists. Try joining or use a different ID."}), 409

    room = Room(room_id=room_id)
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

    session["member_token"] = token
    return jsonify(
        {
            "ok": True,
            "room_id": room.room_id,
            "member_id": member.id,
            "display_name": member.display_name,
            "session_token": token,
            "slots_left": current_app.config["MAX_ROOM_MEMBERS"] - 1,
        }
    )


@bp.post("/join-room")
def join_room():
    data = request.get_json(silent=True) or {}
    room_id = (data.get("room_id") or "").strip()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or "Partner 2").strip()[:64]

    room = Room.query.filter_by(room_id=room_id).first()
    if not room or not room.check_password(password):
        return jsonify({"error": "Invalid Room ID or password"}), 403

    count = room_member_count(room)
    max_members = current_app.config["MAX_ROOM_MEMBERS"]

    existing = Member.query.filter_by(room_pk=room.id, display_name=display_name).first()
    if existing:
        existing.session_token = generate_member_token()
        existing.is_online = True
        existing.last_seen = utcnow()
        db.session.commit()
        session["member_token"] = existing.session_token
        return jsonify(
            {
                "ok": True,
                "room_id": room.room_id,
                "member_id": existing.id,
                "display_name": existing.display_name,
                "session_token": existing.session_token,
                "slots_left": max(0, max_members - count),
                "rejoined": True,
            }
        )

    if count >= max_members:
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
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not join — try a different display name"}), 409
    
    session["member_token"] = token
    return jsonify(
        {
            "ok": True,
            "room_id": room.room_id,
            "member_id": member.id,
            "display_name": member.display_name,
            "session_token": token,
            "slots_left": max_members - count - 1,
        }
    )


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
    return jsonify(
        {
            "member_id": g.member.id,
            "display_name": g.member.display_name,
            "room_id": room.room_id,
            "theme_preset": room.theme_preset,
            "theme_path": room.theme_path,
            "members": members,
            "instagram_sync_url": room.instagram_sync_url,
            "filmtv": room.filmtv_state(),
        }
    )


@bp.post("/display-name")
@login_required
def update_display_name():
    from flask import g
    data = request.get_json(silent=True) or {}
    name = (data.get("display_name") or "").strip()[:64]
    if not name:
        return jsonify({"error": "Display name required"}), 400

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
    g.member.is_online = False
    db.session.commit()
    session.pop("member_token", None)
    return jsonify({"ok": True})


@bp.get("/session-check")
def session_check():
    member = get_member_from_request()
    if not member:
        return jsonify({"authenticated": False}), 401
    return jsonify(
        {
            "authenticated": True,
            "member_id": member.id,
            "display_name": member.display_name,
            "room_id": member.room.room_id,
            "session_token": member.session_token,
        }
    )
'''

# 2. Fixed sockets.py code (Handles disconnect presence sync)
SOCKETS_CODE = '''"""Realtime events: chat presence, doodle strokes, Instagram sync."""

from __future__ import annotations

from flask import request, session
from flask_socketio import emit, join_room, leave_room

from app.extensions import db, socketio
from app.models import Member, utcnow


def _member_from_sid_auth(auth: dict | None) -> Member | None:
    if not auth:
        return None
    token = auth.get("token")
    if not token:
        return None
    return Member.query.filter_by(session_token=token).first()


@socketio.on("connect")
def on_connect(auth=None):
    member = _member_from_sid_auth(auth)
    if not member:
        return False  # reject
    member.is_online = True
    member.last_seen = utcnow()
    db.session.commit()
    room_name = f"room:{member.room.room_id}"
    join_room(room_name)
    emit(
        "presence",
        {
            "member_id": member.id,
            "display_name": member.display_name,
            "online": True,
        },
        room=room_name,
        include_self=False,
    )
    emit("connected", {"member_id": member.id, "room_id": member.room.room_id})


@socketio.on("disconnect")
def on_disconnect():
    try:
        token = session.get("member_token")
        if token:
            member = Member.query.filter_by(session_token=token).first()
            if member:
                member.is_online = False
                member.last_seen = utcnow()
                db.session.commit()
                room_name = f"room:{member.room.room_id}"
                emit(
                    "presence",
                    {
                        "member_id": member.id,
                        "display_name": member.display_name,
                        "online": False,
                    },
                    room=room_name,
                    include_self=False,
                )
    except Exception:
        db.session.rollback()


@socketio.on("leave_room")
def on_leave(data):
    token = (data or {}).get("token")
    member = Member.query.filter_by(session_token=token).first() if token else None
    if not member:
        return
    member.is_online = False
    member.last_seen = utcnow()
    db.session.commit()
    room_name = f"room:{member.room.room_id}"
    emit(
        "presence",
        {
            "member_id": member.id,
            "display_name": member.display_name,
            "online": False,
        },
        room=room_name,
        include_self=False,
    )
    leave_room(room_name)


@socketio.on("typing")
def on_typing(data):
    token = (data or {}).get("token")
    member = Member.query.filter_by(session_token=token).first() if token else None
    if not member:
        return
    emit(
        "typing",
        {"member_id": member.id, "display_name": member.display_name, "typing": bool((data or {}).get("typing"))},
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


@socketio.on("doodle_stroke")
def on_doodle_stroke(data):
    token = (data or {}).get("token")
    member = Member.query.filter_by(session_token=token).first() if token else None
    if not member:
        return
    payload = {
        "points": (data or {}).get("points"),
        "color": (data or {}).get("color", "#e91e63"),
        "width": (data or {}).get("width", 3),
        "tool": (data or {}).get("tool", "pen"),
        "member_id": member.id,
    }
    emit("doodle_stroke", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("doodle_clear")
def on_doodle_clear(data):
    token = (data or {}).get("token")
    member = Member.query.filter_by(session_token=token).first() if token else None
    if not member:
        return
    emit("doodle_clear", {"by": member.display_name}, room=f"room:{member.room.room_id}")


@socketio.on("instagram_nav")
def on_instagram_nav(data):
    token = (data or {}).get("token")
    member = Member.query.filter_by(session_token=token).first() if token else None
    if not member:
        return
    url = (data or {}).get("url", "")
    member.room.instagram_sync_url = url[:1024] if url else None
    db.session.commit()
    emit(
        "instagram_sync",
        {"url": url, "by": member.display_name},
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


def _filmtv_member(data) -> Member | None:
    token = (data or {}).get("token")
    if not token:
        return None
    return Member.query.filter_by(session_token=token).first()


@socketio.on("filmtv_control")
def on_filmtv_control(data):
    member = _filmtv_member(data)
    if not member:
        return
    room = member.room
    action = (data or {}).get("action")
    position = (data or {}).get("position")

    try:
        if position is not None:
            room.filmtv_position = max(0.0, float(position))
    except (TypeError, ValueError):
        pass

    if action == "play":
        room.filmtv_playing = True
    elif action == "pause":
        room.filmtv_playing = False
    elif action == "seek":
        pass
    elif action == "heartbeat":
        pass
    else:
        return

    room.filmtv_updated_at = utcnow()
    db.session.commit()

    payload = {
        "action": action,
        "state": room.filmtv_state(),
        "by": member.display_name,
        "member_id": member.id,
    }
    emit("filmtv_control", payload, room=f"room:{room.room_id}", include_self=False)


@socketio.on("filmtv_request_sync")
def on_filmtv_request_sync(data):
    member = _filmtv_member(data)
    if not member:
        return
    emit("filmtv_state", {"state": member.room.filmtv_state(), "action": "sync", "by": "server"})
'''

def apply_updates():
    auth_path = os.path.join("app", "blueprints", "auth.py")
    sockets_path = os.path.join("app", "sockets.py")

    os.makedirs(os.path.dirname(auth_path), exist_ok=True)
    
    with open(auth_path, "w", encoding="utf-8") as f:
        f.write(AUTH_CODE)
    print(" [✓] Updated: app/blueprints/auth.py successfully.")

    with open(sockets_path, "w", encoding="utf-8") as f:
        f.write(SOCKETS_CODE)
    print(" [✓] Updated: app/sockets.py successfully.")

    print("\n🎉 All fixes applied automatically! Now run your app using: python run.py")

if __name__ == "__main__":
    apply_updates()