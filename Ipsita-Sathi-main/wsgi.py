"""WSGI / production entry — never binds 0.0.0.0 or enables debug by default.

Preferred:  python run.py
Gunicorn:   gunicorn -k eventlet -w 1 'run:app'
"""

from __future__ import annotations

import os

from run import app
from app.extensions import socketio

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        allow_unsafe_werkzeug=False,
    )
