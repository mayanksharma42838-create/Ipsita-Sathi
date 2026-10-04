from __future__ import annotations

from pathlib import Path
import pytest

from app import create_app
from app.config import Config
from app.extensions import db, socketio
from app.models import User, Room, Member


def make_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "NewFeaturesTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-new-features-secret-key",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'new_features.db').as_posix()}",
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


def test_user_email_registration_and_login(app):
    client = app.test_client()

    # Register via email / Gmail
    reg_res = client.post(
        "/api/auth/register",
        json={
            "identifier": "ipsita@gmail.com",
            "account_password": "StrongPassword!2026",
            "display_name": "Ipsita",
        },
    )
    assert reg_res.status_code == 201
    reg_data = reg_res.get_json()
    assert reg_data["ok"] is True
    assert "user_id" in reg_data

    # Duplicate registration fails with 409
    dup_res = client.post(
        "/api/auth/register",
        json={
            "identifier": "ipsita@gmail.com",
            "account_password": "StrongPassword!2026",
            "display_name": "Ipsita",
        },
    )
    assert dup_res.status_code == 409

    # Login via Gmail email + shared room password
    login_res = client.post(
        "/api/auth/login",
        json={
            "identifier": "ipsita@gmail.com",
            "password": "StrongPassword!2026",
        },
    )
    assert login_res.status_code == 200
    login_data = login_res.get_json()
    assert login_data["authenticated"] is True
    assert login_data["session_token"] is not None

    # Persistent Session Check
    check_res = client.get(
        "/api/auth/session-check",
        headers={"X-Session-Token": login_data["session_token"]},
    )
    assert check_res.status_code == 200
    assert check_res.get_json()["authenticated"] is True
