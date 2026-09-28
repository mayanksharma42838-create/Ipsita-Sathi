import os
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS

from app.config import BASE_DIR, Config
from app.extensions import db, socketio


def create_app(config_class=Config):
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
        static_url_path="/static",
    )
    app.config.from_object(config_class)

    # Robust CORS and SocketIO origin parsing from config/env
    raw_origins = app.config.get("CORS_ORIGINS")
    if not raw_origins:
        raw_origins = os.environ.get("CORS_ORIGINS", "http://127.0.0.1:5000")

    if isinstance(raw_origins, str):
        origins = [o.strip() for o in raw_origins.split(",") if o.strip()]
    elif isinstance(raw_origins, (list, tuple)):
        origins = list(raw_origins)
    else:
        origins = ["http://127.0.0.1:5000"]

    CORS(
        app,
        origins=origins,
        supports_credentials=True,
        allow_headers=["Content-Type", "X-Session-Token", "Authorization"],
        methods=["GET", "POST", "OPTIONS"],
    )

    db.init_app(app)
    socketio.init_app(
        app,
        cors_allowed_origins=origins,
        async_mode="eventlet",
        logger=False,
        engineio_logger=False,
    )

    from app.blueprints.auth import bp as auth_bp
    from app.blueprints.api import bp as api_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp)

    from app import sockets as _socket_handlers  # noqa: F401

    @app.route("/")
    def index():
        return render_template("index.html")

    # --- BULLETPROOF FILM-TV SAFE FALLBACK ROUTES (Only active if blueprint route is bypassed) ---
    @app.route("/api/filmtv/state_fallback", methods=["GET"])
    def fallback_filmtv_state():
        return jsonify({"state": None})

    @app.route("/api/filmtv/clear_fallback", methods=["POST"])
    def fallback_filmtv_clear():
        return jsonify({"ok": True, "state": None})
    # ---------------------------------------------------------------------------

    @app.after_request
    def security_headers(response):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "display-capture=(), camera=(), microphone=(self)"
        
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' https://cdn.socket.io https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' blob: data: https://images.unsplash.com https://*.unsplash.com https://picsum.photos https://*.picsum.photos; "
            "media-src 'self' blob: https:; "
            "connect-src 'self' ws: wss: https://cdn.socket.io https://cdnjs.cloudflare.com; "
            "frame-src 'self' blob: https://www.instagram.com https://www.youtube.com https://*.youtube.com https://youtube.com https://youtu.be https://*.google.com https://docs.google.com https://view.officeapps.live.com; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "object-src 'none'"
        )
        return response

    with app.app_context():
        db.create_all()
        _ensure_schema_patches()
        _start_expiry_sweeper(app)

    return app


def _ensure_schema_patches() -> None:
    """Lightweight SQLite migrations for FilmTV columns + nullable session_token."""
    from sqlalchemy import text

    cols = {
        "filmtv_source_type": "VARCHAR(32)",
        "filmtv_source": "VARCHAR(2048)",
        "filmtv_title": "VARCHAR(256)",
        "filmtv_playing": "BOOLEAN DEFAULT 0 NOT NULL",
        "filmtv_position": "FLOAT DEFAULT 0 NOT NULL",
        "filmtv_updated_at": "DATETIME",
    }
    try:
        existing = {
            row[1] for row in db.session.execute(text("PRAGMA table_info(rooms)")).fetchall()
        }
        for name, typedef in cols.items():
            if name not in existing:
                db.session.execute(text(f"ALTER TABLE rooms ADD COLUMN {name} {typedef}"))
        db.session.commit()
    except Exception:
        db.session.rollback()

    try:
        info = db.session.execute(text("PRAGMA table_info(members)")).fetchall()
        tok_col = next((r for r in info if r[1] == "session_token"), None)
        if tok_col is not None and tok_col[3] == 1:  # notnull == 1
            db.session.execute(text("PRAGMA foreign_keys=OFF"))
            db.session.execute(
                text(
                    """
                    CREATE TABLE members_new (
                        id INTEGER NOT NULL PRIMARY KEY,
                        room_pk INTEGER NOT NULL,
                        display_name VARCHAR(64) NOT NULL,
                        session_token VARCHAR(128),
                        joined_at DATETIME NOT NULL,
                        last_seen DATETIME NOT NULL,
                        is_online BOOLEAN NOT NULL,
                        FOREIGN KEY(room_pk) REFERENCES rooms (id),
                        UNIQUE (room_pk, display_name),
                        UNIQUE (session_token)
                    )
                    """
                )
            )
            db.session.execute(
                text(
                    """
                    INSERT INTO members_new
                        (id, room_pk, display_name, session_token, joined_at, last_seen, is_online)
                    SELECT id, room_pk, display_name, session_token, joined_at, last_seen, is_online
                    FROM members
                    """
                )
            )
            db.session.execute(text("DROP TABLE members"))
            db.session.execute(text("ALTER TABLE members_new RENAME TO members"))
            db.session.execute(
                text("CREATE INDEX IF NOT EXISTS ix_members_session_token ON members (session_token)")
            )
            db.session.execute(text("PRAGMA foreign_keys=ON"))
            db.session.commit()
    except Exception:
        db.session.rollback()


def _start_expiry_sweeper(app: Flask) -> None:
    from pathlib import Path as P
    from app.models import Message, utcnow

    def loop():
        while True:
            socketio.sleep(15)
            with app.app_context():
                try:
                    now = utcnow()
                    expired = Message.query.filter(
                        Message.deleted.is_(False),
                        Message.expires_at.isnot(None),
                        Message.expires_at <= now,
                    ).all()
                    if not expired:
                        continue
                    by_room: dict[str, list[int]] = {}
                    for msg in expired:
                        socketio.sleep(0.01)
                        msg.deleted = True
                        if msg.media_path:
                            try:
                                P(msg.media_path).unlink(missing_ok=True)
                            except (OSError, FileNotFoundError):
                                pass
                            msg.media_path = None
                        rid = msg.room.room_id if msg.room else None
                        if rid:
                            by_room.setdefault(rid, []).append(msg.id)
                    db.session.commit()
                    for rid, ids in by_room.items():
                        socketio.emit("messages_expired", {"ids": ids}, room=f"room:{rid}")
                except Exception:
                    db.session.rollback()

    socketio.start_background_task(loop)
        
