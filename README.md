# Ipsita-Sathi

Secure **2-person private room** — Shared Room ID + Secret Password. No public rooms, no AI chatbot.

## Features

1. **Private room auth** — Flask/SQLAlchemy; max 2 members; password hashed server-side  
2. **Display names & themes** — presets + custom background upload  
3. **Rich messaging** — text, voice notes, photos; files under `media_storage/`  
4. **Privacy** — no export APIs; screenshot / capture discouragement on the client  
5. **Instagram sync** — co-watch Reel/post URLs in realtime; optional encrypted session note  
6. **Disappearing messages** — TTL deletes from UI + DB  
7. **Secret doodle board** — shared canvas with local PNG save  
8. **E2E encryption** — AES-GCM on the client (room ID + password); offline outbox sync  
9. **Capacitor** — Android/iOS packaging via `package.json` scripts  

## Quick start

```bash
cd Ipsita-Sathi-main
python -m venv .venv

# Windows
.venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Open http://127.0.0.1:5000

1. Partner A: **Create room** (Room ID + password + display name)  
2. Partner B: **Join room** with the same credentials  

## Mobile (Capacitor)

```bash
npm install
npm run build:www
npx cap add android   # once
# Edit capacitor.config.json → server.url to your PC LAN IP, e.g. http://192.168.1.10:5000
npx cap sync
npx cap open android
```

## Security notes

- Room passwords are never stored in plaintext (Werkzeug hashes).  
- Message bodies are encrypted in the browser before upload; the DB stores ciphertext only.  
- Chat history **export is permanently blocked** (`/api/export` → 403).  
- Web screenshot blocking is best-effort (OS-level capture cannot be fully prevented in a browser).  

## Project layout

```
app/                 Flask factory, models, crypto, sockets, blueprints
static/              CSS + client JS (crypto, offline, doodle, privacy)
templates/           SPA shell
media_storage/       Local uploads, themes, doodles
instance/            SQLite DB
run.py               Server entry
capacitor.config.json
```
