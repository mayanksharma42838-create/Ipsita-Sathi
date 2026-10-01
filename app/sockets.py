from __future__ import annotations

import threading
import math

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


def _member_from_sid() -> Member | None:
    sid = getattr(request, "sid", None)
    if not sid:
        return None
    with _sid_lock:
        mid = _sid_to_member.get(sid)
    if not mid:
        return None
    member = Member.query.get(mid)
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
    emit("connected", {"member_id": member.id, "room_id": member.room.room_id})
    peers = Member.query.filter_by(room_pk=member.room_pk).all()
    for peer in peers:
        if peer.id != member.id:
            emit("presence", {"display_name": peer.display_name, "online": peer.is_online})
    socketio.emit(
        "presence",
        {"display_name": member.display_name, "online": True},
        room=room_name,
        include_self=False,
    )


@socketio.on("disconnect")
def on_disconnect():
    try:
        mid = _unbind_sid(request.sid)
        if mid is None:
            return
        member = Member.query.get(mid)
        if not member:
            return
        with _sid_lock:
            still = bool(_member_to_sids.get(mid))
        if still:
            return
        member.is_online = False
        member.last_seen = utcnow()
        db.session.commit()
        socketio.emit(
            "presence",
            {"display_name": member.display_name, "online": False},
            room=f"room:{member.room.room_id}",
        )
    except Exception:
        db.session.rollback()


@socketio.on("filmtv_control")
def on_filmtv_control(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    room = member.room
    action = data.get("action")
    position = data.get("position")

    if (
        not room.filmtv_source
        or room.filmtv_host_id != member.id
        or action not in {"play", "pause", "seek", "heartbeat"}
        or not rate_limit(f"filmtv_control:{member.id}", *current_app.config["RL_SOCKET"])
    ):
        return

    if position is not None:
        try:
            parsed_position = float(position)
        except (TypeError, ValueError):
            return
        if not math.isfinite(parsed_position):
            return
        room.filmtv_position = max(0.0, parsed_position)

    if action == "play":
        room.filmtv_playing = True
    elif action == "pause":
        room.filmtv_playing = False

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
    if not member:
        return
    emit("filmtv_state", {"state": member.room.filmtv_state(), "action": "sync", "by": "server"})