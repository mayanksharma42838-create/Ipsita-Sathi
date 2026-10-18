"""Ipsita-Sathi — secure 2-person private room server."""

import os

from app import create_app
from app.extensions import socketio

app = create_app()

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    # allow_unsafe_werkzeug stays False — never enable the Werkzeug reloader
    # production escape hatch unless an operator explicitly opts in.
    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        allow_unsafe_werkzeug=os.environ.get("ALLOW_UNSAFE_WERKZEUG", "0") == "1",
        use_reloader=False,
    )
