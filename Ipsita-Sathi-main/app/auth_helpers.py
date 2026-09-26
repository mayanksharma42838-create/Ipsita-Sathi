from __future__ import annotations

from functools import wraps

from flask import g, jsonify, request, session

from app.extensions import db
from app.models import Member, Room, utcnow


def get_member_from_request() -> Member | None:
    """Authenticate via header or Flask session cookie — never query-string tokens."""
    try:
        # Explicitly ignore ?token= / request.args (V-04)
        token = (
            request.headers.get("X-Session-Token")
            or _bearer_token()
            or session.get("member_token")
        )
        if not token:
            return None
        
        member = Member.query.filter_by(session_token=token).first()
        if not member or not member.session_token:
            return None

        # Keep cookie in sync so <video src> / CSS url() can auth without ?token=
        if session.get("member_token") != token:
            session["member_token"] = token

        member.last_seen = utcnow()
        db.session.commit()
        return member
    except Exception:
        db.session.rollback()
        return None


def _bearer_token() -> str | None:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        member = get_member_from_request()
        if not member:
            return jsonify({"error": "Unauthorized"}), 401
        g.member = member
        g.room = member.room
        return fn(*args, **kwargs)

    return wrapper


def room_member_count(room: Room) -> int:
    try:
        return Member.query.filter_by(room_pk=room.id).count()
    except Exception:
        return 0