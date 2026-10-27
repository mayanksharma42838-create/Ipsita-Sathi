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


def disconnect_member(member_id: int) -> None:
    with _sid_lock:
        sids = tuple(_member_to_sids.get(member_id, ()))
    for sid in sids:
        try:
            socketio.server.disconnect(sid, namespace="/")
        except Exception:
            _unbind_sid(sid)


def _member_from_sid() -> Member | None:
    sid = getattr(request, "sid", None)
    if not sid:
        return None
    with _sid_lock:
        mid = _sid_to_member.get(sid)
    if not mid:
        return None
    member = db.session.get(Member, mid)
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
        disconnect()
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
        member = db.session.get(Member, mid)
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


@socketio.on("filmtv_search")
def on_filmtv_search(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    query = data.get("query")
    if (
        not isinstance(query, str)
        or not (query := query.strip())
        or len(query) > 300
        or not rate_limit(f"filmtv_search:{member.id}", *current_app.config["RL_FILMTV"])
    ):
        return
    emit(
        "filmtv_search",
        {"query": query, "by": member.display_name, "member_id": member.id},
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


@socketio.on("filmtv_provider_launch")
def on_filmtv_provider_launch(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    provider = data.get("provider")
    if (
        not isinstance(provider, str)
        or provider not in {"teleparty", "rave"}
        or not rate_limit(f"filmtv_provider_launch:{member.id}", *current_app.config["RL_FILMTV"])
    ):
        return
    emit(
        "filmtv_provider_launch",
        {"provider": provider, "by": member.display_name, "member_id": member.id},
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


# ─── WebRTC Screen & Tab Sharing Signaling ───

@socketio.on("webrtc_offer")
def on_webrtc_offer(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    emit("webrtc_offer", {
        "sdp": data.get("sdp"),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("webrtc_answer")
def on_webrtc_answer(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    emit("webrtc_answer", {
        "sdp": data.get("sdp"),
        "sender_id": member.id,
    }, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("webrtc_ice_candidate")
def on_webrtc_ice_candidate(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    emit("webrtc_ice_candidate", {
        "candidate": data.get("candidate"),
        "sender_id": member.id,
    }, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("webrtc_stop_screen")
def on_webrtc_stop_screen(data=None):
    member = _member_from_sid()
    if not member:
        return
    emit("webrtc_stop_screen", {
        "sender_id": member.id,
    }, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("widget_sync")
def on_widget_sync(data):
    """Real-time sync for Home Screen Floating Widget (drawings, notes, photo previews)."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    
    payload = {
        "sender_id": member.id,
        "sender_name": member.display_name,
        "type": data.get("type", "note"), # note, doodle, photo
        "content": data.get("content"),
        "timestamp": utcnow().isoformat(),
    }
    emit("widget_sync", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("typing")
def on_typing(data):
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    is_typing = bool(data.get("typing", False))
    emit(
        "typing",
        {"member_id": member.id, "display_name": member.display_name, "typing": is_typing},
        room=f"room:{member.room.room_id}",
        include_self=False,
    )


@socketio.on("game_action")
def on_game_action(data):
    """Broadcast co-op mini-game actions (Overcooked kitchen actions, moves, resets)."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    emit("game_action", data, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("game_score_update")
def on_game_score_update(data):
    """Broadcast high scores and game achievements to partner."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "sender_id": member.id,
        "sender_name": member.display_name,
        "game": data.get("game"),
        "score": data.get("score"),
        "msg": data.get("msg"),
    }
    emit("game_score_update", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("netflix_play")
def on_netflix_play(data):
    """Synchronize Netflix playback play action."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": "play",
        "position": data.get("position", 0.0),
        "url": data.get("url"),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("netflix_play", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("netflix_pause")
def on_netflix_pause(data):
    """Synchronize Netflix playback pause action."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": "pause",
        "position": data.get("position", 0.0),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("netflix_pause", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("netflix_seek")
def on_netflix_seek(data):
    """Synchronize Netflix playback seek action."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": "seek",
        "position": data.get("position", 0.0),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("netflix_seek", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("message_reaction")
def on_message_reaction(data):
    """Broadcast WhatsApp-style emoji reaction (❤️, 👍, 😂, 😮, 😢, 🙏) to room."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    msg_id = data.get("msg_id")
    reaction = data.get("reaction")
    if not msg_id or not reaction:
        return
    payload = {
        "msg_id": msg_id,
        "reaction": reaction,
        "member_id": member.id,
        "sender_name": member.display_name,
    }
    emit("message_reaction", payload, room=f"room:{member.room.room_id}")


@socketio.on("read_receipt")
def on_read_receipt(data=None):
    """Broadcast WhatsApp-style double blue read ticks."""
    member = _member_from_sid()
    if not member:
        return
    emit("read_receipt", {"member_id": member.id, "display_name": member.display_name}, room=f"room:{member.room.room_id}")


# ─── New Synced Modules (YouTube Watch Party, Local Video, Aesthetic Timer & Study Music) ───

@socketio.on("yt_sync")
def on_yt_sync(data):
    """Broadcast YouTube player synchronization actions (play, pause, seek, load)."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": data.get("action"),
        "video_id": data.get("video_id"),
        "time": data.get("time", 0.0),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("yt_sync", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("video_sync")
def on_video_sync(data):
    """Broadcast Local Uploaded Video synchronization actions."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": data.get("action"),
        "src": data.get("src"),
        "time": data.get("time", 0.0),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("video_sync", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("timer_sync")
def on_timer_sync(data):
    """Broadcast Aesthetic Study Pomodoro Timer state (start, pause, reset, tick, set_mode, theme)."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": data.get("action"),
        "time_left": data.get("time_left"),
        "mode": data.get("mode"),
        "preset": data.get("preset"),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("timer_sync", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("music_sync")
def on_music_sync(data):
    """Broadcast Synced Study Lofi Music state (play, pause, track, volume)."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": data.get("action"),
        "track_id": data.get("track_id"),
        "time": data.get("time", 0.0),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("music_sync", payload, room=f"room:{member.room.room_id}", include_self=False)


@socketio.on("doc_annotation_sync")
def on_doc_annotation_sync(data):
    """Broadcast interactive document highlights, underlines, and study notes."""
    member = _member_from_sid()
    if not member or not isinstance(data, dict):
        return
    payload = {
        "action": data.get("action"),
        "doc_id": data.get("doc_id"),
        "annotation": data.get("annotation"),
        "sender_id": member.id,
        "sender_name": member.display_name,
    }
    emit("doc_annotation_sync", payload, room=f"room:{member.room.room_id}", include_self=False)
