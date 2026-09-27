import os
import uuid
from flask import Flask, render_template, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

from app.config import BASE_DIR, Config
from app.extensions import db, socketio
from app.models import Member, Room, utcnow


def create_app(config_class=Config):
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
        static_url_path="/static",
    )
    app.config.from_object(config_class)
    
    # Badi files ke upload par server crash rokne ke liye limit (500MB)
    app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

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

    # --- FILM-TV DATABASE ROUTES WITH CHUNKED UPLOADS ---
    MEDIA_DIR = BASE_DIR / "media_storage" / "filmtv"
    os.makedirs(MEDIA_DIR, exist_ok=True)

    @app.route("/api/filmtv/source", methods=["POST"])
    def filmtv_source_api():
        token = request.headers.get("X-Session-Token")
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
        
        member = Member.query.filter_by(session_token=token).first()
        if not member or not member.room:
            return jsonify({"error": "Room not found"}), 404
            
        room = member.room
        data = request.get_json() or {}
        source = data.get("source") or data.get("url")
        source_type = data.get("source_type", "url")
        title = data.get("title", "Shared Workspace")
        
        room.filmtv_source = source
        room.filmtv_source_type = source_type
        room.filmtv_title = title
        room.filmtv_playing = False
        room.filmtv_position = 0.0
        room.filmtv_host_id = member.id
        room.filmtv_updated_at = utcnow()
        db.session.commit()
        
        state_payload = room.filmtv_state()
        socketio.emit("filmtv_state", {"state": state_payload}, room=f"room:{room.room_id}")
        return jsonify({"ok": True, "state": state_payload})

    @app.route("/api/filmtv/load", methods=["POST"])
    def filmtv_load_api():
        return filmtv_source_api()

    @app.route("/api/filmtv/upload", methods=["POST"])
    def filmtv_upload_api():
        token = request.headers.get("X-Session-Token")
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
        
        member = Member.query.filter_by(session_token=token).first()
        if not member or not member.room:
            return jsonify({"error": "Room not found"}), 404
            
        room = member.room
        file = request.files.get("file")
        if not file:
            return jsonify({"error": "No file uploaded"}), 400
            
        filename = secure_filename(file.filename or "video.mp4")
        unique_name = f"room-{room.room_id}_{uuid.uuid4().hex}_{filename}"
        file_path = os.path.join(MEDIA_DIR, unique_name)
        
        try:
            # Chunked writing to prevent memory exhaustion / server hang
            with open(file_path, "wb") as f:
                while True:
                    chunk = file.stream.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
        except Exception as e:
            return jsonify({"error": f"File save failed: {str(e)}"}), 500
        
        room.filmtv_source = file_path
        room.filmtv_source_type = "upload"
        room.filmtv_title = request.form.get("title") or filename
        room.filmtv_playing = False
        room.filmtv_position = 0.0
        room.filmtv_host_id = member.id
        room.filmtv_updated_at = utcnow()
        db.session.commit()
        
        state_payload = room.filmtv_state()
        socketio.emit("filmtv_state", {"state": state_payload}, room=f"room:{room.room_id}")
        return jsonify({"ok": True, "state": state_payload})

    @app.route("/api/filmtv/stream", methods=["GET"])
    def filmtv_stream_api():
        token = request.args.get("token") or request.headers.get("X-Session-Token")
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
            
        member = Member.query.filter_by(session_token=token).first()
        if not member or not member.room or not member.room.filmtv_source:
            return jsonify({"error": "Source not found"}), 404
            
        file_path = member.room.filmtv_source
        if not os.path.exists(file_path):
            return jsonify({"error": "File not found on server"}), 404
            
        return send_file(file_path, conditional=True)

    @app.route("/api/filmtv/state", methods=["GET"])
    def filmtv_state_api():
        token = request.headers.get("X-Session-Token")
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
            
        member = Member.query.filter_by(session_token=token).first()
        if not member or not member.room or not member.room.filmtv_source:
            return jsonify({"state": None})
            
        room = member.room
        return jsonify({"state": room.filmtv_state()})

    @app.route("/api/filmtv/clear", methods=["POST"])
    def filmtv_clear_api():
        token = request.headers.get("X-Session-Token")
        if not token:
            return jsonify({"error": "Unauthorized"}), 401
            
        member = Member.query.filter_by(session_token=token).first()
        if not member or not member.room:
            return jsonify({"ok": True, "state": None})
            
        room = member.room
        room.filmtv_source = None
        room.filmtv_source_type = None
        room.filmtv_title = None
        room.filmtv_playing = False
        room.filmtv_position = 0.0
        room.filmtv_host_id = None
        room.filmtv_updated_at = utcnow()
        db.session.commit()
        
        socketio.emit("filmtv_state", {"state": None}, room=f"room:{room.room_id}")
        return jsonify({"ok": True, "state": None})

    @app.after_request
    def security_headers(response):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Frame-Options"] = "DENY"
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
            "frame-src https://www.instagram.com https://www.youtube.com https://*.youtube.com https://*.google.com https://docs.google.com https://view.officeapps.live.com; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "object-src 'none'"
        )
        return response

    with app.app_context():
        db.create_all()

    return app