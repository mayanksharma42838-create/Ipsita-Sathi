from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO

db = SQLAlchemy()
# Origins configured in create_app via init_app
socketio = SocketIO(async_mode="threading")
