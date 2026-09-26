"""Realtime events with sid→member binding and rate limits."""

from __future__ import annotations

import threading

import eventlet
from flask import current_app, request
from flask_socketio import disconnect, emit, join_room, leave_room

from app.extensions import db, socketio
from app.models import Member, utcnow
from app.security import rate_limit, sanitize_instagram_url

_sid_lock = threading.Lock()
_sid_to_member: dict[str, int] = {}
_member_to_sids: dict[int, set[str]] = {}


def _bind_sid(sid: str, member_id: int) -> None:
    with _sid_lock:
        _sid_to_member[sid] = member_id
        _member_to_sids.setdefault(member_id, set()).add(sid)


def _unbind_sid(sid: str) -> int | None:
    with _sid_lock:
        mid = _sid_to_member.pop(sid, None)
        if mid is not None:
            sids = _member_to_sids.get(mid)
            if sids:
                sids.discard(sid)
                if not sids:
                    _member_to_sids.pop(mid, None)
        return mid


def disconnect_member(member_id: int) -> None:
    """Force-disconnect all sockets for a member (e.g. logout)."""
    with _sid_lock:
        sids = list(_member_to_sids.get(member_id, set()))
    for sid in sids:
        try:
            socketio.server.disconnect(sid)
        except Exception:
            pass
        _unbind_sid(sid)
        eventlet.sleep(0)


def _member_from_sid() -> Member | None:
    sid = getattr(request, "sid", None)
    if not sid:
        return None
    with _sid_lock:
        mid = _sid_to_member.get(sid)
    if not mid:
        return None
    member = Member.query.get(mid)
    # Reject if token revoked (logout) — sid bind alone is not enough (V-02/V-11)
    if not member or not member.session_token:
        if sid:
            _unbind_sid(sid)
            try:
                disconnect()
            except Exception:
                pass
        return None
    return member


def _member_from_sid_auth(auth: dict | None) -> Member | None:
    if not auth or not isinstance(auth, dict):
        return None
    token = auth.get("token")
    if not token or not isinstance(token, str):
        return None
    return Member.query.filter_by(session_token=token).first()


def _socket_allowed(member: Member | None, bucket: str = "socket") -> bool:
    if not member:
        return False
    limit, window = current_app.config.get("RL_SOCKET", (120, 60))
    return rate_limit(f"{bucket}:m{member.id}", limit, window)


@socketio.on("connect")
def on_connect(auth=None):
    member = _member_from_sid_auth(auth)
    if not member or not member.session_token:
        return False
    _bind_sid(request.sid, member.id)
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
        mid = _unbind_sid(request.sid)
        if mid is None:
            return
        member = Member.query.get(mid)
        if not member:
            return
        # Only mark offline if no other live sids for this member
        with _sid_lock:
            still = bool(_member_to_sids.get(mid))
        if still:
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
    except Exception:
        db.session.rollback()


@socketio.on("leave_room")
def on_leave(_data=None):
    member = _member_from_sid()
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
    _unbind_sid(request.sid)


@socketio.on("typing")
def on_typing(data):
    member = _member_from_sid()
    if not _socket_allowed(member, "typing"):
        return
    emit(
        "typing",
        {
            "member_id": member.id,
            "display_name": member.display_name,
            "typing": bool((data or {}).get("typing")),
        },
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


@socketio.on("doodle_stroke")
def on_doodle_stroke(data):
    member = _member_from_sid()
    if not _socket_allowed(member, "doodle"):
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
def on_doodle_clear(_data=None):
    member = _member_from_sid()
    if not _socket_allowed(member, "doodle_clear"):
        return
    emit("doodle_clear", {"by": member.display_name}, room=f"room:{member.room.room_id}")


@socketio.on("instagram_nav")
def on_instagram_nav(data):
    member = _member_from_sid()
    if not _socket_allowed(member, "ig"):
        return
    raw = (data or {}).get("url", "")
    url = sanitize_instagram_url(raw) if raw else None
    if raw and not url:
        emit("error", {"error": "Instagram URL not allowed"})
        return
    member.room.instagram_sync_url = url
    db.session.commit()
    emit(
        "instagram_sync",
        {"url": url or "", "by": member.display_name},
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


@socketio.on("filmtv_control")
def on_filmtv_control(data):
    member = _member_from_sid()
    if not _socket_allowed(member, "filmtv"):
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
    elif action in ("seek", "heartbeat"):
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
def on_filmtv_request_sync(_data=None):
    member = _member_from_sid()
    if not _socket_allowed(member, "filmtv_sync"):
        return
    emit("filmtv_state", {"state": member.room.filmtv_state(), "action": "sync", "by": "server"})
