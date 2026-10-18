from __future__ import annotations

from pathlib import Path
import pytest

from app import create_app
from app.config import Config
from app.extensions import db, socketio


def make_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "NetflixTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-netflix-test-secret-key",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'netflix_test.db').as_posix()}",
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


def test_netflix_watch_party_socket_events(app):
    client = app.test_client()
    login_res = client.post(
        "/api/auth/login",
        json={"phone_number": "15557778888", "password": "NetflixTestPassword!123"},
    )
    assert login_res.status_code == 200
    token = login_res.get_json()["session_token"]

    socket_client = socketio.test_client(app, auth={"token": token})
    assert socket_client.is_connected()

    # Emit netflix_play
    socket_client.emit("netflix_play", {"url": "https://www.netflix.com/watch/80192098", "position": 0.0})
    # Emit netflix_pause
    socket_client.emit("netflix_pause", {"position": 120.5})
    # Emit netflix_seek
    socket_client.emit("netflix_seek", {"position": 340.0})

    second_client = app.test_client()
    second_login = second_client.post(
        "/api/auth/login",
        json={"phone_number": "15557778888", "password": "NetflixTestPassword!123"},
    )
    assert second_login.status_code == 200
    assert second_login.get_json()["room_id"] == login_res.get_json()["room_id"]
    second_socket = socketio.test_client(app, auth={"token": second_login.get_json()["session_token"]})
    assert second_socket.is_connected()
    socket_client.get_received()
    second_socket.get_received()

    for provider in ("teleparty", "rave"):
        socket_client.emit("filmtv_provider_launch", {"provider": provider})
        received = second_socket.get_received()
        assert any(
            item["name"] == "filmtv_provider_launch"
            and item["args"][0]["provider"] == provider
            for item in received
        ), received

    socket_client.emit("filmtv_provider_launch", {"provider": ["https://attacker.example"]})
    assert not any(
        item["name"] == "filmtv_provider_launch"
        for item in second_socket.get_received()
    )
    socket_client.disconnect()
    second_socket.disconnect()
