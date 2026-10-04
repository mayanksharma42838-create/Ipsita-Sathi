from __future__ import annotations

from pathlib import Path
import pytest

from app import create_app
from app.config import Config
from app.extensions import db, socketio
from app.models import Member, Message, Room, User, utcnow


def make_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "E2EAuditTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-e2e-audit-secret-key",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'e2e_audit.db').as_posix()}",
            "MEDIA_DIR": str(media_dir),
            "THEMES_DIR": paths["themes"],
            "UPLOADS_DIR": paths["uploads"],
            "DOODLES_DIR": paths["doodles"],
            "FILMTV_DIR": paths["filmtv"],
            "CORS_ORIGINS": ["http://localhost"],
            "RL_AUTH": (100, 60),
            "RL_MESSAGES": (100, 60),
            "RL_UPLOAD": (100, 60),
            "RL_FILMTV": (100, 60),
            "RL_SOCKET": (100, 60),
        },
    )


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(socketio, "start_background_task", lambda *args, **kwargs: None)
    flask_app = create_app(make_test_config(tmp_path))
    yield flask_app
    with flask_app.app_context():
        db.session.remove()
        db.engine.dispose()


def test_e2e_auth_messaging_socket_audit(app):
    client = app.test_client()

    # 1. Register User A via Gmail
    reg1 = client.post(
        "/api/auth/register",
        json={
            "identifier": "user_a@gmail.com",
            "account_password": "AccountPassword123!",
            "display_name": "Ipsita",
        },
    )
    assert reg1.status_code == 201

    # 2. Login User A and create shared room
    login1 = client.post(
        "/api/auth/login",
        json={
            "identifier": "user_a@gmail.com",
            "password": "AccountPassword123!",
        },
    )
    assert login1.status_code == 200
    data1 = login1.get_json()
    token1 = data1["session_token"]
    headers1 = {"X-Session-Token": token1}

    # 3. Post a message
    msg_res = client.post(
        "/api/messages",
        headers=headers1,
        json={"ciphertext": "encrypted-hello-message", "msg_type": "text"},
    )
    assert msg_res.status_code == 200

    # 4. Fetch messages (verifies joinedload query execution)
    list_res = client.get("/api/messages", headers=headers1)
    assert list_res.status_code == 200
    messages = list_res.get_json()["messages"]
    assert len(messages) == 1
    assert messages[0]["ciphertext"] == "encrypted-hello-message"

    # 5. Connect Socket.IO client and test real-time events
    socket1 = socketio.test_client(app, auth={"token": token1})
    assert socket1.is_connected()

    # Netflix play/pause/seek events
    socket1.emit("netflix_play", {"url": "https://www.netflix.com/watch/12345", "position": 10.0})
    socket1.emit("netflix_pause", {"position": 15.0})
    socket1.emit("netflix_seek", {"position": 45.0})

    # Couple Games events
    socket1.emit("game_action", {"game": "overcooked", "type": "action", "kitchen": {}})
    socket1.emit("game_score_update", {"game": "candycrush", "score": 500, "msg": "Match 5 combo!"})

    # Floating Widget sync event
    socket1.emit("widget_sync", {"type": "note", "content": "Live floating widget text"})

    socket1.disconnect()

    # 6. Session check verification
    session_res = client.get("/api/auth/session-check", headers=headers1)
    assert session_res.status_code == 200
    assert session_res.get_json()["authenticated"] is True
    assert session_res.get_json()["email"] == "user_a@gmail.com"
