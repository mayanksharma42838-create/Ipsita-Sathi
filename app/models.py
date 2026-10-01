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
    
    # FilmTV watch party state columns
    filmtv_source_type = db.Column(db.String(32), nullable=True)
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
        pos = float(self.filmtv_position or 0.0)
        if self.filmtv_playing and self.filmtv_updated_at:
            ref = self.filmtv_updated_at
            if ref.tzinfo is None:
                ref = ref.replace(tzinfo=timezone.utc)
            elapsed = (utcnow() - ref).total_seconds()
            if elapsed > 0:
                pos += elapsed
        
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
    ciphertext = db.Column(db.Text, nullable=False)
    msg_type = db.Column(db.String(32), nullable=False, default="text")
    media_path = db.Column(db.String(512), nullable=True)
    media_mime = db.Column(db.String(128), nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=True, index=True)
    deleted = db.Column(db.Boolean, default=False, nullable=False)

    room = db.relationship("Room", back_populates="messages")
    sender = db.relationship("Member")


class FilmTVAnnotation(db.Model):
    __tablename__ = "filmtv_annotations"

    id = db.Column(db.Integer, primary_key=True)
    room_pk = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False, index=True)
    document_key = db.Column(db.String(64), nullable=False, index=True)
    page_number = db.Column(db.Integer, nullable=False)
    kind = db.Column(db.String(16), nullable=False)
    x = db.Column(db.Float, nullable=False)
    y = db.Column(db.Float, nullable=False)
    width = db.Column(db.Float, nullable=False)
    height = db.Column(db.Float, nullable=False)
    color = db.Column(db.String(16), nullable=False)
    created_by = db.Column(db.Integer, db.ForeignKey("members.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    __table_args__ = (
        db.Index("ix_filmtv_annotation_document_page", "room_pk", "document_key", "page_number"),
    )