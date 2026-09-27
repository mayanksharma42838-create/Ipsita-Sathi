from __future__ import annotations

from datetime import datetime, timezone

from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Room(db.Model):
    __tablename__ = "rooms"

    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.String(64), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    salt = db.Column(db.LargeBinary(16), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    theme_path = db.Column(db.String(512), nullable=True)
    theme_preset = db.Column(db.String(64), default="blush", nullable=False)
    theme_opacity = db.Column(db.Float, default=0.92, nullable=False)
    instagram_session_enc = db.Column(db.Text, nullable=True)
    instagram_sync_url = db.Column(db.String(1024), nullable=True)
    doodle_path = db.Column(db.String(512), nullable=True)
    # FilmTV watch party state
    filmtv_source_type = db.Column(db.String(32), nullable=True)  # url|upload (native only)
    filmtv_source = db.Column(db.String(2048), nullable=True)
    filmtv_title = db.Column(db.String(256), nullable=True)
    filmtv_playing = db.Column(db.Boolean, default=False, nullable=False)
    filmtv_position = db.Column(db.Float, default=0.0, nullable=False)
    filmtv_updated_at = db.Column(db.DateTime, nullable=True)
    filmtv_host_id = db.Column(db.Integer, db.ForeignKey("members.id"), nullable=True)
    filmtv_scroll_top = db.Column(db.Integer, default=0, nullable=False)

    members = db.relationship("Member", back_populates="room", cascade="all, delete-orphan", foreign_keys="Member.room_pk")
    messages = db.relationship("Message", back_populates="room", cascade="all, delete-orphan")

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

                def filmtv_state(self) -> dict:
        """Playback snapshot with lag-compensated position estimate."""
        pos = float(self.filmtv_position or 0.0)
        if self.filmtv_playing and self.filmtv_updated_at:
            ref = self.filmtv_updated_at
            if ref.tzinfo is None:
                ref = ref.replace(tzinfo=timezone.utc)
            elapsed = (utcnow() - ref).total_seconds()
            if elapsed > 0:
                pos += elapsed
        
        # Identify the active streaming host and append session token if needed for auth bypass
        # But we must be careful not to leak a member's token. We'll rely on the cookie 
        # or append the room's token explicitly on the frontend.
        return {
            "source_type": self.filmtv_source_type,
            "source": self.filmtv_source,
            "stream_url": "/api/filmtv/stream" if self.filmtv_source_type == "upload" else self.filmtv_source,
            "title": self.filmtv_title,
            "playing": bool(self.filmtv_playing),
            "position": round(pos, 3),
            "host_id": self.filmtv_host_id,
            "updated_at": self.filmtv_updated_at.isoformat() if self.filmtv_updated_at else None,
            "server_time": utcnow().isoformat(),
        }






class Member(db.Model):
    __tablename__ = "members"

    id = db.Column(db.Integer, primary_key=True)
    room_pk = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False)
    display_name = db.Column(db.String(64), nullable=False, default="Partner")
    session_token = db.Column(db.String(128), unique=True, nullable=True, index=True)
    joined_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    last_seen = db.Column(db.DateTime, default=utcnow, nullable=False)
    is_online = db.Column(db.Boolean, default=False, nullable=False)

    room = db.relationship("Room", back_populates="members", foreign_keys=[room_pk])

    __table_args__ = (
        db.UniqueConstraint("room_pk", "display_name", name="uq_room_display_name"),
    )


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True)
    room_pk = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False, index=True)
    sender_id = db.Column(db.Integer, db.ForeignKey("members.id"), nullable=False)
    # ciphertext only — never store plaintext
    ciphertext = db.Column(db.Text, nullable=False)
    msg_type = db.Column(db.String(32), nullable=False, default="text")  # text|image|voice|system
    media_path = db.Column(db.String(512), nullable=True)  # encrypted file path if any
    media_mime = db.Column(db.String(128), nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=True, index=True)
    deleted = db.Column(db.Boolean, default=False, nullable=False)

    room = db.relationship("Room", back_populates="messages")
    sender = db.relationship("Member")

    def is_expired(self) -> bool:
        if self.expires_at is None:
            return False
        exp = self.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return utcnow() >= exp