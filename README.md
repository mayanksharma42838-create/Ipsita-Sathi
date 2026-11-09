# Ipsita-Sathi

Secure **2-person private room** — Phone number + Room Password. No public rooms, no AI chatbot.

## Features

1. **Permanent phone login** — each phone number maps to one persistent room; room passwords are Werkzeug-hashed; max 2 active members
2. **Display names & themes** — presets + custom background upload
3. **Rich messaging** — text, voice notes, photos; files under `media_storage/`
4. **Privacy** — no export APIs; screenshot / capture discouragement on the client
5. **Instagram sync** — co-watch Reel/post URLs in realtime; optional encrypted session note
6. **Disappearing messages** — messages expire only when a TTL is explicitly selected
7. **Secret doodle board** — shared canvas saved to room storage and restored on login
8. **E2E encryption** — encrypted on the client using the stable room key and salt; offline outbox sync
9. **Capacitor** — Android/iOS packaging via `package.json` scripts

## FilmTV uploads

- FilmTV accepts files up to 10 GiB by default (`FILMTV_MAX_BYTES`) and sends them in 32 MiB chunks (`FILMTV_CHUNK_BYTES`) with visible progress. `MAX_CONTENT_LENGTH` only needs to allow a chunk plus multipart overhead.
- Videos and documents use the same shared upload; MP4/WebM playback, YouTube play/pause/seek, and room state are synchronized through the host's controls. Browser autoplay rules and supported video codecs still apply.
- Uploaded PDFs open in the shared page viewer. Room members can add persistent, color-coded highlights and underlines; page navigation and annotation changes sync live.
- The application stores uploads on local disk. A deployment must provide at least 10 GiB of durable storage plus headroom, allow the configured chunk request size, and use shared storage when running multiple instances. The included Render free service does not provide that storage guarantee; large uploads require a suitable persistent disk or object-storage deployment.
- FilmTV validates common container signatures but does not transcode unsupported codecs.

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

1. Partner A: enter a phone number and a strong room password. A new private room is created automatically.
2. Partner B: enter the same phone number and room password to take the second private-room seat.
3. Returning members use the same credentials; the existing room, history, theme, media, and saved doodle are restored.
4. Existing rooms made with the old login can be linked once using their old Room ID and password.

For authentication tests, install the development requirements and run `python -m pytest`:

```bash
pip install -r requirements-dev.txt
python -m pytest
```

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
