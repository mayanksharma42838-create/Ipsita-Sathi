from __future__ import annotations

from app.crypto_utils import (
    derive_room_key,
    encrypt_text,
    decrypt_text,
    encrypt_bytes,
    decrypt_bytes,
    generate_member_token,
)


def test_derive_room_key_deterministic_with_salt():
    key1, salt = derive_room_key("room123", "SecretPassword!123")
    key2, _ = derive_room_key("room123", "SecretPassword!123", salt=salt)
    assert key1 == key2


def test_text_encryption_decryption():
    key, _ = derive_room_key("room123", "SecretPassword!123")
    plaintext = "Hello, Ipsita-Sathi!"

    ciphertext = encrypt_text(plaintext, key)
    assert ciphertext != plaintext

    decrypted = decrypt_text(ciphertext, key)
    assert decrypted == plaintext


def test_text_decryption_invalid_key():
    key1, _ = derive_room_key("room123", "SecretPassword!123")
    key2, _ = derive_room_key("room123", "WrongPassword!456")

    ciphertext = encrypt_text("Secret Message", key1)
    decrypted = decrypt_text(ciphertext, key2)
    assert decrypted is None


def test_bytes_encryption_decryption():
    key, _ = derive_room_key("room123", "SecretPassword!123")
    data = b"\x00\x01\x02\x03\x04\x05\xff"

    encrypted = encrypt_bytes(data, key)
    assert encrypted != data

    decrypted = decrypt_bytes(encrypted, key)
    assert decrypted == data


def test_generate_member_token():
    token1 = generate_member_token()
    token2 = generate_member_token()
    assert len(token1) > 20
    assert token1 != token2
