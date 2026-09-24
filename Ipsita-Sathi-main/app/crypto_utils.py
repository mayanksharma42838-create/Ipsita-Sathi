"""Symmetric encryption helpers for message/media payloads.

True E2E: the room password never leaves the client for message keys.
Server stores ciphertext only. Room credentials are hashed (Werkzeug).
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


def derive_room_key(room_id: str, password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    """Derive a Fernet-compatible key from room_id + password."""
    if salt is None:
        salt = hashlib.sha256(f"ipsita-sathi:{room_id}".encode()).digest()[:16]
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=390_000,
    )
    raw = kdf.derive(f"{room_id}:{password}".encode("utf-8"))
    key = base64.urlsafe_b64encode(raw)
    return key, salt


def encrypt_text(plaintext: str, key: bytes) -> str:
    token = Fernet(key).encrypt(plaintext.encode("utf-8"))
    return token.decode("utf-8")


def decrypt_text(ciphertext: str, key: bytes) -> str | None:
    try:
        return Fernet(key).decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except (InvalidToken, Exception):
        return None


def encrypt_bytes(data: bytes, key: bytes) -> bytes:
    return Fernet(key).encrypt(data)


def decrypt_bytes(data: bytes, key: bytes) -> bytes | None:
    try:
        return Fernet(key).decrypt(data)
    except (InvalidToken, Exception):
        return None


def generate_member_token() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode("utf-8").rstrip("=")
