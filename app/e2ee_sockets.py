"""Production-Grade Flask-SocketIO E2EE Handshake and Messaging Handlers.

Server acts as a zero-knowledge signal router / public key registry for 1-to-1 sessions.
No private keys or plaintext messages pass through these event handlers.
"""

from flask import request
from flask_socketio import emit, join_room, leave_room
from app.extensions import socketio

# Ephemeral in-memory store for active session public keys: room_id -> { user_id: spki_b64 }
_PUBLIC_KEY_REGISTRY = {}


def register_e2ee_socket_events(socketio_instance):
    """Register E2EE WebSocket handlers."""

    @socketio_instance.on("e2ee_register_public_key")
    def handle_register_public_key(data):
        """Client registers its exported RSA-OAEP public key (SPKI Base64) for the active room session."""
        room_id = data.get("room_id")
        user_id = data.get("user_id")
        spki_b64 = data.get("public_key")

        if not room_id or not user_id or not spki_b64:
            emit("e2ee_error", {"error": "Missing room_id, user_id, or public_key"})
            return

        join_room(room_id)

        if room_id not in _PUBLIC_KEY_REGISTRY:
            _PUBLIC_KEY_REGISTRY[room_id] = {}

        _PUBLIC_KEY_REGISTRY[room_id][user_id] = spki_b64

        # Broadcast public key update to room members
        emit(
            "e2ee_public_key_registered",
            {
                "user_id": user_id,
                "public_key": spki_b64,
                "all_keys": _PUBLIC_KEY_REGISTRY[room_id],
            },
            room=room_id,
        )

    @socketio_instance.on("e2ee_initiate_handshake")
    def handle_initiate_handshake(data):
        """Relays the RSA-OAEP encrypted AES session key from sender to recipient."""
        room_id = data.get("room_id")
        target_user_id = data.get("target_user_id")
        sender_id = data.get("sender_id")
        encrypted_session_key = data.get("encrypted_session_key")

        if not room_id or not target_user_id or not encrypted_session_key:
            emit("e2ee_error", {"error": "Invalid handshake payload"})
            return

        # Forward encrypted session key to room for target recipient
        emit(
            "e2ee_handshake_payload",
            {
                "sender_id": sender_id,
                "target_user_id": target_user_id,
                "encrypted_session_key": encrypted_session_key,
            },
            room=room_id,
        )

    @socketio_instance.on("e2ee_send_message")
    def handle_send_message(data):
        """Relays AES-GCM encrypted message or photo reference payload to room participants."""
        room_id = data.get("room_id")
        sender_id = data.get("sender_id")
        payload = data.get("payload")  # { iv, ciphertext, type: "text"|"photo", media_id }

        if not room_id or not sender_id or not payload:
            emit("e2ee_error", {"error": "Invalid message payload"})
            return

        emit(
            "e2ee_receive_message",
            {
                "sender_id": sender_id,
                "payload": payload,
                "timestamp": data.get("timestamp"),
            },
            room=room_id,
            include_self=False,
        )
