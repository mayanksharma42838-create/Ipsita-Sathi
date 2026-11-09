from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest

from app import create_app
from app import config as config_module
from app.config import Config
from app.extensions import db, socketio
from app.models import FilmTVAnnotation, Member, Message, Room, utcnow


def make_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "PhoneLoginTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-phone-login-secret-key",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'rooms.db').as_posix()}",
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


def login(client, phone_number: str, password: str, **extra):
    return client.post(
        "/api/auth/login",
        json={"phone_number": phone_number, "password": password, **extra},
    )


def test_default_flask_signing_key_is_stable_across_restarts(tmp_path, monkeypatch):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.setattr(config_module, "INSTANCE_DIR", tmp_path)

    first_key = config_module._stable_secret_key()
    restarted_key = config_module._stable_secret_key()

    assert len(first_key) >= 32
    assert restarted_key == first_key
    assert (tmp_path / "flask_secret.key").read_text(encoding="utf-8").strip() == first_key


def test_phone_login_restores_room_history_theme_and_doodle(app):
    client = app.test_client()
    phone_number = "+1 (555) 222-3344"
    password = "Permanent!RoomPassword2026"

    first_login = login(client, phone_number, password)
    assert first_login.status_code == 200
    first = first_login.get_json()
    headers = {"X-Session-Token": first["session_token"]}

    message = client.post(
        "/api/messages",
        headers=headers,
        json={"ciphertext": "saved-ciphertext", "msg_type": "text"},
    )
    assert message.status_code == 200
    theme = client.post("/api/theme", headers=headers, json={"theme_preset": "forest"})
    assert theme.status_code == 200

    png = b"\x89PNG\r\n\x1a\n" + bytes(64)
    doodle = client.post(
        "/api/doodle/save",
        headers=headers,
        data={"file": (BytesIO(png), "board.png")},
        content_type="multipart/form-data",
    )
    assert doodle.status_code == 200

    logout = client.post("/api/auth/logout", headers=headers)
    assert logout.status_code == 200
    assert client.get("/api/messages", headers=headers).status_code == 401

    restored_login = login(client, "15552223344", password)
    assert restored_login.status_code == 200
    restored = restored_login.get_json()
    restored_headers = {"X-Session-Token": restored["session_token"]}

    assert restored["room_id"] == first["room_id"]
    assert restored["member_id"] == first["member_id"]
    assert restored["salt"] == first["salt"]
    assert restored["theme_preset"] == "forest"
    history = client.get("/api/messages", headers=restored_headers).get_json()["messages"]
    assert [item["ciphertext"] for item in history] == ["saved-ciphertext"]
    assert client.get("/api/doodle/latest", headers=restored_headers).data == png

    session_check = client.get("/api/auth/session-check", headers=restored_headers).get_json()
    assert session_check["authenticated"] is True
    assert session_check["phone_number"] == "15552223344"


def test_http_only_cookie_can_restore_and_logout_without_bearer_header(app):
    client = app.test_client()
    response = login(client, "15550007770", "Cookie!OnlyRoomPassword2026")
    assert response.status_code == 200
    set_cookie = response.headers.get("Set-Cookie", "")
    assert "HttpOnly" in set_cookie

    restored = client.get("/api/auth/session-check")
    assert restored.get_json()["authenticated"] is True

    logout_response = client.post("/api/auth/logout")
    assert logout_response.status_code == 200
    assert client.get("/api/auth/session-check").get_json()["authenticated"] is False


def test_session_and_room_survive_flask_app_restart(app, tmp_path):
    phone_number = "15556667777"
    password = "Restart!RoomPassword2026"
    first_client = app.test_client()
    first_login = login(first_client, phone_number, password)
    assert first_login.status_code == 200
    first = first_login.get_json()
    headers = {"X-Session-Token": first["session_token"]}

    sent = first_client.post(
        "/api/messages",
        headers=headers,
        json={"ciphertext": "survives-restart", "msg_type": "text"},
    )
    assert sent.status_code == 200

    with app.app_context():
        db.session.remove()
        db.engine.dispose()
    restarted_app = create_app(make_test_config(tmp_path))
    try:
        client = restarted_app.test_client()
        checked = client.get("/api/auth/session-check", headers=headers)
        assert checked.status_code == 200
        assert checked.get_json()["authenticated"] is True
        assert checked.get_json()["room_id"] == first["room_id"]

        restored = login(
            client,
            phone_number,
            password,
            resume_token=first["session_token"],
        )
        assert restored.status_code == 200
        data = restored.get_json()
        assert data["room_id"] == first["room_id"]
        assert data["salt"] == first["salt"]
        history = client.get(
            "/api/messages",
            headers={"X-Session-Token": data["session_token"]},
        ).get_json()["messages"]
        assert [item["ciphertext"] for item in history] == ["survives-restart"]
    finally:
        with restarted_app.app_context():
            db.session.remove()
            db.engine.dispose()


def test_phone_room_keeps_two_member_limit_and_rejects_wrong_password(app):
    phone_number = "15553334444"
    password = "TwoPeople!PrivateRoom26"
    first = app.test_client()
    second = app.test_client()
    third = app.test_client()

    first_login = login(first, phone_number, password)
    assert first_login.status_code == 200
    room_id = first_login.get_json()["room_id"]

    assert login(second, phone_number, "Wrong!Password2026").status_code == 403
    second_login = login(second, phone_number, password)
    assert second_login.status_code == 200
    assert second_login.get_json()["room_id"] == room_id
    assert second_login.get_json()["member_id"] != first_login.get_json()["member_id"]
    assert login(third, phone_number, password).status_code == 403

    with app.app_context():
        room = Room.query.filter_by(phone_number=phone_number).one()
        assert Member.query.filter_by(room_pk=room.id).count() == 2


def test_room_and_content_are_deleted_after_both_members_logout(app):
    phone_number = "15550009991"
    password = "DeleteRoom!AfterLogout2026"
    first_client = app.test_client()
    second_client = app.test_client()
    first = login(first_client, phone_number, password).get_json()
    second = login(second_client, phone_number, password).get_json()
    first_headers = {"X-Session-Token": first["session_token"]}
    second_headers = {"X-Session-Token": second["session_token"]}

    with app.app_context():
        room = Room.query.filter_by(room_id=first["room_id"]).one()
        media_dir = Path(app.config["MEDIA_DIR"])
        paths = [
            Path(app.config["UPLOADS_DIR"]) / "private.enc",
            Path(app.config["THEMES_DIR"]) / "theme_room.png",
            Path(app.config["DOODLES_DIR"]) / "doodle_room.png",
            Path(app.config["FILMTV_DIR"]) / "video_room.mp4",
        ]
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"room-private-content")
        room.theme_path = str(paths[1])
        room.doodle_path = str(paths[2])
        room.filmtv_source_type = "upload"
        room.filmtv_source = str(paths[3])
        message = Message(
            room_pk=room.id,
            sender_id=first["member_id"],
            ciphertext="encrypted-message",
            msg_type="image",
            media_path=str(paths[0]),
        )
        db.session.add(message)
        db.session.flush()
        db.session.add(
            FilmTVAnnotation(
                room_pk=room.id,
                document_key="private-document",
                page_number=1,
                kind="highlight",
                x=0.1,
                y=0.1,
                width=0.2,
                height=0.1,
                color="yellow",
                created_by=first["member_id"],
            )
        )
        db.session.commit()
        room_db_id = room.id

    first_logout = first_client.post("/api/auth/logout", headers=first_headers)
    assert first_logout.status_code == 200
    assert first_logout.get_json()["room_deleted"] is False
    assert second_client.get("/api/messages", headers=second_headers).status_code == 200
    assert first_client.get("/api/messages", headers=first_headers).status_code == 401
    assert all(path.is_file() for path in paths)

    second_logout = second_client.post("/api/auth/logout", headers=second_headers)
    assert second_logout.status_code == 200
    assert second_logout.get_json()["room_deleted"] is True
    assert second_client.get("/api/messages", headers=second_headers).status_code == 401

    with app.app_context():
        assert db.session.get(Room, room_db_id) is None
        assert Message.query.filter_by(room_pk=room_db_id).count() == 0
        assert FilmTVAnnotation.query.filter_by(room_pk=room_db_id).count() == 0
    assert all(not path.exists() for path in paths)

    recreated = login(app.test_client(), phone_number, password).get_json()
    assert recreated["room_id"] != first["room_id"]


def test_legacy_room_can_be_linked_once_without_losing_messages(app):
    password = "Legacy!RoomPassword2026"
    with app.app_context():
        room = Room(
            room_id="old-room-id",
            salt=b"legacy-room-salt",
            theme_opacity=0.92,
        )
        room.set_password(password)
        db.session.add(room)
        db.session.flush()
        member = Member(
            room_pk=room.id,
            display_name="Partner 1",
            session_token=None,
            is_online=False,
            last_seen=utcnow(),
        )
        db.session.add(member)
        db.session.flush()
        db.session.add(
            Message(
                room_pk=room.id,
                sender_id=member.id,
                ciphertext="legacy-history",
                msg_type="text",
            )
        )
        db.session.commit()

    response = login(
        app.test_client(),
        "15554445555",
        password,
        legacy_room_id="old-room-id",
    )
    assert response.status_code == 200
    data = response.get_json()
    assert data["room_id"] == "old-room-id"
    with app.test_client() as client:
        history = client.get(
            "/api/messages",
            headers={"X-Session-Token": data["session_token"]},
        ).get_json()["messages"]
    assert [item["ciphertext"] for item in history] == ["legacy-history"]