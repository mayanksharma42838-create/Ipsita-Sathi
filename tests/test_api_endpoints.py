from __future__ import annotations

import time
from io import BytesIO
from pathlib import Path
import pytest

from app import create_app
from app.config import Config
from app.extensions import db, socketio
from app.models import Member, Message, Room, utcnow


def make_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "ApiTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-api-test-secret-key",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'api_test.db').as_posix()}",
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


def login_user(client, phone="15550001111", password="TestPassword!123"):
    return client.post(
        "/api/auth/login",
        json={"phone_number": phone, "password": password},
    )


def test_export_blocked_returns_403(app):
    client = app.test_client()
    login_res = login_user(client)
    assert login_res.status_code == 200
    headers = {"X-Session-Token": login_res.get_json()["session_token"]}

    res = client.get("/api/export", headers=headers)
    assert res.status_code == 403
    assert "permanently disabled" in res.get_json()["error"]


def test_display_name_update_and_conflict(app):
    client = app.test_client()
    user1 = login_user(client, "15550001111", "TestPassword!123").get_json()
    headers1 = {"X-Session-Token": user1["session_token"]}

    # Update name successfully
    res = client.post("/api/auth/display-name", headers=headers1, json={"display_name": "Alice"})
    assert res.status_code == 200
    assert res.get_json()["display_name"] == "Alice"

    # Second user joins same room
    client2 = app.test_client()
    user2 = login_user(client2, "15550001111", "TestPassword!123").get_json()
    headers2 = {"X-Session-Token": user2["session_token"]}

    # Trying to claim 'Alice' returns 409 Conflict
    res_conflict = client2.post("/api/auth/display-name", headers=headers2, json={"display_name": "Alice"})
    assert res_conflict.status_code == 409


def test_media_upload_gallery_and_expiry(app):
    client = app.test_client()
    user = login_user(client).get_json()
    headers = {"X-Session-Token": user["session_token"]}

    png_data = b"\x89PNG\r\n\x1a\n" + bytes(64)
    upload_res = client.post(
        "/api/media",
        headers=headers,
        data={
            "file": (BytesIO(png_data), "photo.png"),
            "ciphertext": "encrypted-photo-caption",
            "msg_type": "image",
            "ttl_seconds": 2,  # 2 second TTL
        },
        content_type="multipart/form-data",
    )
    assert upload_res.status_code == 200
    msg_id = upload_res.get_json()["message"]["id"]

    # Gallery lists the media item
    gallery_res = client.get("/api/gallery", headers=headers)
    assert gallery_res.status_code == 200
    items = gallery_res.get_json()["gallery"]
    assert len(items) == 1
    assert items[0]["id"] == msg_id

    # Fetching media before expiry succeeds
    media_file_res = client.get(f"/api/media/{msg_id}", headers=headers)
    assert media_file_res.status_code == 200

    # Wait for TTL to expire
    time.sleep(2.1)

    # Fetching messages triggers purge of expired message
    msgs_res = client.get("/api/messages", headers=headers)
    assert msgs_res.status_code == 200
    assert len(msgs_res.get_json()["messages"]) == 0

    # Gallery is now empty
    gallery_res_after = client.get("/api/gallery", headers=headers)
    assert len(gallery_res_after.get_json()["gallery"]) == 0


def test_fallback_filmtv_routes(app):
    client = app.test_client()
    res_state = client.get("/api/filmtv/state_fallback")
    assert res_state.status_code == 200
    assert res_state.get_json() == {"state": None}

    res_clear = client.post("/api/filmtv/clear_fallback")
    assert res_clear.status_code == 200
    assert res_clear.get_json() == {"ok": True, "state": None}
