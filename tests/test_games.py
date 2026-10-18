from __future__ import annotations

from pathlib import Path
import pytest

from app import create_app
from app.config import Config
from app.extensions import db, socketio
from app.models import Room, Member


def make_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "GamesTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-games-test-secret-key",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'games_test.db').as_posix()}",
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


def test_game_socket_events(app):
    client = app.test_client()
    login_res = client.post(
        "/api/auth/login",
        json={"phone_number": "15559990000", "password": "GamesTestPassword!123"},
    )
    assert login_res.status_code == 200
    token = login_res.get_json()["session_token"]

    socket_client = socketio.test_client(app, auth={"token": token})
    assert socket_client.is_connected()

    # Emit game action
    socket_client.emit("game_action", {"game": "overcooked", "type": "action", "action": "chop"})
    # Emit game score update
    socket_client.emit("game_score_update", {"game": "candycrush", "score": 300, "msg": "Candy match!"})

    socket_client.disconnect()
