"""Production-Ready E2EE Blueprint for Zero-Knowledge Media Storage.

Provides REST endpoints for encrypted media uploads/downloads.
The server receives only raw AES-GCM binary blobs and returns opaque identifiers.
No decryption keys or plaintext ever touch the server.
"""

import os
import uuid
from flask import Blueprint, jsonify, request, send_file, current_app
from app.auth_helpers import login_required, get_member_from_request

e2ee_bp = Blueprint("e2ee", __name__)

STORAGE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "storage", "encrypted_media")

def _ensure_storage_dir():
    if not os.path.exists(STORAGE_DIR):
        os.makedirs(STORAGE_DIR, exist_ok=True)


@e2ee_bp.route("/api/e2ee/upload-media", methods=["POST"])
@login_required
def upload_encrypted_media():
    """Accepts raw AES-GCM encrypted media blob (IV + Ciphertext) and stores it on disk."""
    _ensure_storage_dir()
    
    if "file" not in request.files:
        return jsonify({"error": "No binary file provided in request"}), 400
        
    file = request.files["file"]
    if not file or file.filename == "":
        return jsonify({"error": "Empty file payload"}), 400
        
    # Generate unique media payload ID
    media_id = str(uuid.uuid4())
    filepath = os.path.join(STORAGE_DIR, f"{media_id}.enc")
    
    # Save ciphertext binary directly to disk without reading/modifying contents
    file.save(filepath)
    
    return jsonify({
        "status": "success",
        "media_id": media_id,
        "size_bytes": os.path.getsize(filepath)
    }), 201


@e2ee_bp.route("/api/e2ee/media/<media_id>", methods=["GET"])
@login_required
def download_encrypted_media(media_id):
    """Retrieves raw AES-GCM encrypted media blob by media_id."""
    _ensure_storage_dir()
    
    # Sanitize media_id to prevent path traversal
    safe_id = os.path.basename(media_id).replace(".enc", "")
    filepath = os.path.join(STORAGE_DIR, f"{safe_id}.enc")
    
    if not os.path.exists(filepath):
        return jsonify({"error": "Encrypted media file not found"}), 404
        
    return send_file(
        filepath,
        mimetype="application/octet-stream",
        as_attachment=False,
        download_name=f"{safe_id}.enc"
    )
