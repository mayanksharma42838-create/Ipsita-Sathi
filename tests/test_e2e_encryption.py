"""Zero-Knowledge End-to-End Encryption (E2EE) and Secure Vault Verification Suite."""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
import pytest

from app import create_app
from app.config import Config
from app.crypto_utils import (
    derive_room_key,
    encrypt_text,
    decrypt_text,
    encrypt_bytes,
    decrypt_bytes,
)
from app.extensions import db, socketio
from app.models import Member, Message, Room, User


def make_encryption_test_config(tmp_path):
    media_dir = tmp_path / "media"
    paths = {
        name: str(media_dir / name)
        for name in ("themes", "uploads", "doodles", "filmtv")
    }
    for path in paths.values():
        Path(path).mkdir(parents=True, exist_ok=True)

    return type(
        "EncryptionTestConfig",
        (Config,),
        {
            "TESTING": True,
            "SECRET_KEY": "pytest-e2ee-vault-secret-key-32chars",
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'e2ee_vault.db').as_posix()}",
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
    flask_app = create_app(make_encryption_test_config(tmp_path))
    yield flask_app
    with flask_app.app_context():
        db.session.remove()
        db.engine.dispose()


def test_zero_knowledge_message_encryption_and_decryption(app):
    client = app.test_client()
    phone = "15551112222"
    room_password = "PrivateRoomPassword!2026"

    login_res = client.post(
        "/api/auth/login",
        json={"phone_number": phone, "password": room_password},
    )
    assert login_res.status_code == 200
    data = login_res.get_json()
    room_id = data["room_id"]
    salt = base64.b64decode(data["salt"])
    headers = {"X-Session-Token": data["session_token"]}

    correct_key, _ = derive_room_key(room_id, room_password, salt=salt)
    wrong_key, _ = derive_room_key(room_id, "WrongPassword!999", salt=salt)

    plaintext = "Top Secret Personal Message for Vault"
    ciphertext = encrypt_text(plaintext, correct_key)

    post_res = client.post(
        "/api/messages",
        headers=headers,
        json={"ciphertext": ciphertext, "msg_type": "text"},
    )
    assert post_res.status_code == 200

    with app.app_context():
        db_msg = Message.query.filter_by(id=post_res.get_json()["message"]["id"]).one()
        assert db_msg.ciphertext != plaintext
        assert db_msg.ciphertext == ciphertext

        assert decrypt_text(db_msg.ciphertext, correct_key) == plaintext
        assert decrypt_text(db_msg.ciphertext, wrong_key) is None


def test_zero_knowledge_media_vault_encryption(app):
    client = app.test_client()
    phone = "15553334444"
    room_password = "MediaVaultPassword!2026"

    login_res = client.post(
        "/api/auth/login",
        json={"phone_number": phone, "password": room_password},
    )
    data = login_res.get_json()
    room_id = data["room_id"]
    salt = base64.b64decode(data["salt"])
    headers = {"X-Session-Token": data["session_token"]}

    key, _ = derive_room_key(room_id, room_password, salt=salt)
    wrong_key, _ = derive_room_key(room_id, "WrongMediaPass!123", salt=salt)

    raw_photo_bytes = b"RAW_UNENCRYPTED_IMAGE_PIXELS_DATA"
    encrypted_photo_bytes = encrypt_bytes(raw_photo_bytes, key)

    caption_cipher = encrypt_text("Sunset in Hawaii", key)
    upload_res = client.post(
        "/api/media",
        headers=headers,
        data={
            "file": (BytesIO(encrypted_photo_bytes), "vault_photo.enc"),
            "ciphertext": caption_cipher,
            "msg_type": "image",
        },
        content_type="multipart/form-data",
    )
    assert upload_res.status_code == 200
    msg_id = upload_res.get_json()["message"]["id"]

    with app.app_context():
        db_msg = Message.query.get(msg_id)
        file_path = Path(db_msg.media_path)
        disk_bytes = file_path.read_bytes()

        assert disk_bytes != raw_photo_bytes
        assert disk_bytes == encrypted_photo_bytes

        assert decrypt_bytes(disk_bytes, key) == raw_photo_bytes
        assert decrypt_bytes(disk_bytes, wrong_key) is None

    gallery_res = client.get("/api/gallery", headers=headers)
    assert gallery_res.status_code == 200
    gallery = gallery_res.get_json()["gallery"]
    assert len(gallery) == 1
    assert gallery[0]["id"] == msg_id


def test_vault_history_permanently_persisted(app):
    client = app.test_client()
    phone = "15555556666"
    password = "PermanentVaultPassword!2026"

    login_1 = client.post("/api/auth/login", json={"phone_number": phone, "password": password}).get_json()
    headers_1 = {"X-Session-Token": login_1["session_token"]}

    client.post(
        "/api/messages",
        headers=headers_1,
        json={"ciphertext": "persisted-message-token", "msg_type": "text"},
    )

    client.post("/api/auth/logout", headers=headers_1)

    login_2 = client.post("/api/auth/login", json={"phone_number": phone, "password": password}).get_json()
    headers_2 = {"X-Session-Token": login_2["session_token"]}

    history = client.get("/api/messages", headers=headers_2).get_json()["messages"]
    assert len(history) == 1
    assert history[0]["ciphertext"] == "persisted-message-token"