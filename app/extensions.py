from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO

db = SQLAlchemy()
# Eventlet async mode explicit define karein taaki WebSocket handshake fail na ho
socketio = SocketIO(cors_allowed_origins="*", async_mode="eventlet")