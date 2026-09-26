#!/usr/bin/env python3
"""Ipsita-Sathi — 3-stage simulation (normal / adversarial / stress).

Run from project root:
  .\\.venv\\Scripts\\python.exe scripts\\simulate_3stage.py
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app
from app.extensions import db, socketio

PASS = 0
FAIL = 0
RESULTS: list[tuple[str, bool, str]] = []


def ok(name: str, detail: str = "") -> None:
    global PASS
    PASS += 1
    RESULTS.append((name, True, detail))
    print(f"  ✓ {name}" + (f" — {detail}" if detail else ""))


def bad(name: str, detail: str = "") -> None:
    global FAIL
    FAIL += 1
    RESULTS.append((name, False, detail))
    print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))


def expect(cond: bool, name: str, detail: str = "") -> None:
    (ok if cond else bad)(name, detail if cond else (detail or "assertion failed"))


# ─── Stage 1: Normal user flow ───────────────────────────────────────


def stage1_normal(app):
    print("\n═══ STAGE 1 — Normal User Flow ═══")
    c = app.test_client()
    rid = f"sim_normal_{int(time.time()) % 100000}"
    pw = "SecurePass!99x"

    r = c.post(
        "/api/auth/create-room",
        json={"room_id": rid, "password": pw, "display_name": "Ipsita"},
    )
    expect(r.status_code == 200, "create_room", f"status={r.status_code}")
    data = r.get_json() or {}
    tok_a = data.get("session_token")
    expect(bool(tok_a), "session_token_issued")
    h_a = {"X-Session-Token": tok_a, "Content-Type": "application/json"}

    r = c.post(
        "/api/auth/join-room",
        json={"room_id": rid, "password": pw, "display_name": "Sathi"},
    )
    expect(r.status_code == 200, "partner_join", f"status={r.status_code}")
    tok_b = (r.get_json() or {}).get("session_token")
    h_b = {"X-Session-Token": tok_b, "Content-Type": "application/json"}

    # Encrypted-looking ciphertext (opaque to server)
    cipher = "v1." + ("AbCdEfGh" * 8)
    r = c.post("/api/messages", headers=h_a, json={"ciphertext": cipher, "msg_type": "text"})
    expect(r.status_code == 200, "send_message", f"status={r.status_code}")

    r = c.get("/api/messages", headers=h_b)
    msgs = (r.get_json() or {}).get("messages") or []
    expect(r.status_code == 200 and len(msgs) >= 1, "partner_receives_message", f"n={len(msgs)}")
    expect(
        all("ciphertext" in m and "plaintext" not in m for m in msgs),
        "server_stores_ciphertext_only",
    )

    # Theme navigation
    r = c.post("/api/theme", headers=h_a, json={"theme_preset": "midnight"})
    expect(r.status_code == 200, "theme_switch")

    # Doodle PNG save
    png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(64)
    r = c.post(
        "/api/doodle/save",
        headers={"X-Session-Token": tok_a},
        data={"file": (BytesIO(png), "board.png")},
        content_type="multipart/form-data",
    )
    expect(r.status_code == 200, "doodle_save_png")

    # FilmTV direct HTTPS mp4
    r = c.post(
        "/api/filmtv/load",
        headers=h_a,
        json={"url": "https://cdn.example.com/party/film.mp4", "title": "Our movie"},
    )
    expect(r.status_code == 200, "filmtv_direct_mp4")
    state = (r.get_json() or {}).get("state") or {}
    expect(state.get("source_type") == "url", "filmtv_state_url")

    # Instagram sync
    r = c.post(
        "/api/instagram/sync",
        headers=h_a,
        json={"url": "https://www.instagram.com/reel/CxYzAb12/"},
    )
    expect(r.status_code == 200, "instagram_reel_sync")

    # me / session
    r = c.get("/api/auth/me", headers=h_a)
    me = r.get_json() or {}
    expect(r.status_code == 200 and me.get("room_id") == rid, "auth_me")
    expect(len(me.get("members") or []) == 2, "two_members_present")

    # Socket connect both
    sa = socketio.test_client(app, flask_test_client=c, auth={"token": tok_a})
    sb = socketio.test_client(app, flask_test_client=c, auth={"token": tok_b})
    expect(sa.is_connected(), "socket_a_connected")
    expect(sb.is_connected(), "socket_b_connected")
    sa.emit("typing", {"typing": True})
    time.sleep(0.15)
    received = sb.get_received()
    typing_ok = any(e.get("name") == "typing" for e in received)
    expect(typing_ok, "socket_typing_relay")
    sa.disconnect()
    sb.disconnect()

    return rid, pw, tok_a, tok_b


# ─── Stage 2: Chaotic / adversarial ──────────────────────────────────


def stage2_chaotic(app):
    print("\n═══ STAGE 2 — Chaotic / Adversarial User ═══")
    c = app.test_client()
    rid = f"sim_chaos_{int(time.time()) % 100000}"
    pw = "SecurePass!99x"

    r = c.post(
        "/api/auth/create-room",
        json={"room_id": rid, "password": pw, "display_name": "Host"},
    )
    expect(r.status_code == 200, "chaos_room_create")
    tok = (r.get_json() or {})["session_token"]
    h = {"X-Session-Token": tok, "Content-Type": "application/json"}

    # Scripted / HTML display name
    r = c.post(
        "/api/auth/join-room",
        json={
            "room_id": rid,
            "password": pw,
            "display_name": '<script>alert(1)</script>',
        },
    )
    expect(r.status_code == 400, "reject_xss_display_name", f"status={r.status_code}")

    # Overlong name
    r = c.post(
        "/api/auth/join-room",
        json={"room_id": rid, "password": pw, "display_name": "X" * 200},
    )
    # sanitize truncates to 64 — may succeed if alphanumeric; use control chars
    r = c.post(
        "/api/auth/join-room",
        json={"room_id": rid, "password": pw, "display_name": "Bad\x00Name"},
    )
    expect(r.status_code == 400, "reject_control_char_name")

    # Weak password room
    r = c.post(
        "/api/auth/create-room",
        json={"room_id": rid + "_w", "password": "123456", "display_name": "X"},
    )
    expect(r.status_code == 400, "reject_weak_password")

    # Session steal without resume
    r = c.post(
        "/api/auth/join-room",
        json={"room_id": rid, "password": pw, "display_name": "Guest"},
    )
    expect(r.status_code == 200, "guest_join")
    r = c.post(
        "/api/auth/join-room",
        json={"room_id": rid, "password": pw, "display_name": "Host"},
    )
    expect(r.status_code == 403, "block_session_hijack")

    # Third member
    r = c.post(
        "/api/auth/join-room",
        json={"room_id": rid, "password": pw, "display_name": "Intruder"},
    )
    expect(r.status_code == 403, "block_third_member", (r.get_json() or {}).get("error", "")[:60])

    # YouTube / streaming sites
    for label, url in [
        ("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
        ("youtu_be", "https://youtu.be/dQw4w9WgXcQ"),
        ("vimeo", "https://vimeo.com/123456"),
        ("http_mp4", "http://cdn.example.com/a.mp4"),
        ("loopback", "https://127.0.0.1/secret.mp4"),
        ("lan", "https://192.168.0.10/clip.webm"),
        ("html_page", "https://cdn.example.com/watch.html"),
    ]:
        r = c.post("/api/filmtv/load", headers=h, json={"url": url})
        expect(
            r.status_code == 400,
            f"reject_filmtv_{label}",
            (r.get_json() or {}).get("error", "")[:70],
        )

    # Valid direct video still ok
    r = c.post(
        "/api/filmtv/load",
        headers=h,
        json={"url": "https://media.example.org/clips/demo.webm"},
    )
    expect(r.status_code == 200, "allow_direct_webm")

    # Malformed doodle
    r = c.post(
        "/api/doodle/save",
        headers={"X-Session-Token": tok},
        data={"file": (BytesIO(b"<svg>xss</svg>"), "x.png")},
        content_type="multipart/form-data",
    )
    expect(r.status_code == 400, "reject_fake_png_doodle")

    # Bad theme upload
    r = c.post(
        "/api/theme/upload",
        headers={"X-Session-Token": tok},
        data={"file": (BytesIO(b"MZ\x90fakeexe"), "theme.jpg")},
        content_type="multipart/form-data",
    )
    expect(r.status_code == 400, "reject_fake_theme_image")

    # Spam ciphertext oversize
    r = c.post("/api/messages", headers=h, json={"ciphertext": "Z" * 40000})
    expect(r.status_code == 400, "reject_oversized_ciphertext")

    # Message spam → eventually 429
    hit_429 = False
    for i in range(80):
        r = c.post(
            "/api/messages",
            headers=h,
            json={"ciphertext": f"spam.{i}." + ("x" * 32)},
        )
        if r.status_code == 429:
            hit_429 = True
            break
    expect(hit_429, "rate_limit_message_spam")

    # Query token leak path
    with c.session_transaction() as sess:
        sess.clear()
    r = c.get("/api/messages", query_string={"token": tok})
    expect(r.status_code == 401, "ignore_query_string_token")

    # Evil Instagram
    r = c.post(
        "/api/instagram/sync",
        headers={**h, "X-Session-Token": tok},
        json={"url": "https://evil.example/phish"},
    )
    # need header again after session clear — re-set
    h2 = {"X-Session-Token": tok, "Content-Type": "application/json"}
    r = c.post("/api/instagram/sync", headers=h2, json={"url": "https://evil.example/phish"})
    expect(r.status_code == 400, "reject_evil_iframe_url")

    # Export blocked
    r = c.get("/api/export", headers=h2)
    expect(r.status_code == 403, "export_permanently_blocked")

    # Logout revoke
    r = c.post("/api/auth/logout", headers=h2)
    expect(r.status_code == 200, "logout_ok")
    r = c.get("/api/auth/me", headers=h2)
    expect(r.status_code == 401, "token_dead_after_logout")


# ─── Stage 3: Heavy load / concurrency ───────────────────────────────


def stage3_stress(app):
    print("\n═══ STAGE 3 — Heavy Load / Concurrency ═══")
    rid = f"sim_stress_{int(time.time()) % 100000}"
    pw = "StressTest!99aa"

    # Seed room with creator
    with app.test_client() as seed:
        r = seed.post(
            "/api/auth/create-room",
            json={"room_id": rid, "password": pw, "display_name": "Alpha"},
        )
        expect(r.status_code == 200, "stress_seed_room")
        tok_a = (r.get_json() or {})["session_token"]

    # 20 parallel join attempts as Beta — exactly one should succeed as new seat;
    # rest must be 403 full or rejoined with resume (we don't send resume → full after 1)
    results_codes: list[int] = []
    lock = threading.Lock()

    def try_join(i: int) -> int:
        with app.test_client() as c:
            r = c.post(
                "/api/auth/join-room",
                json={
                    "room_id": rid,
                    "password": pw,
                    "display_name": "Beta",
                },
            )
            with lock:
                results_codes.append(r.status_code)
            return r.status_code

    with ThreadPoolExecutor(max_workers=20) as pool:
        futs = [pool.submit(try_join, i) for i in range(20)]
        for f in as_completed(futs):
            f.result()

    successes = sum(1 for s in results_codes if s == 200)
    forbidden = sum(1 for s in results_codes if s == 403)
    # First joiner(s) with same name: first creates seat; subsequent without resume_token
    # while online get 403. Under race, unique constraint may yield 409.
    conflicts = sum(1 for s in results_codes if s in (403, 409))
    expect(successes >= 1, "stress_at_least_one_beta_join", f"ok={successes}")
    expect(successes <= 1, "stress_no_duplicate_beta_seat", f"ok={successes} codes={results_codes[:10]}...")
    expect(conflicts >= 15, "stress_rest_rejected", f"rej={conflicts}")

    # Third-name flood must never create a 3rd member
    third_ok = 0

    def try_gamma(i: int) -> int:
        nonlocal third_ok
        with app.test_client() as c:
            r = c.post(
                "/api/auth/join-room",
                json={"room_id": rid, "password": pw, "display_name": f"Gamma{i}"},
            )
            if r.status_code == 200:
                third_ok += 1
            return r.status_code

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(try_gamma, range(16)))
    expect(third_ok == 0, "stress_hard_cap_two_members", f"leaked={third_ok}")

    # Count members in DB
    with app.app_context():
        from app.models import Member, Room

        room = Room.query.filter_by(room_id=rid).first()
        n = Member.query.filter_by(room_pk=room.id).count() if room else -1
    expect(n == 2, "db_member_count_is_two", f"count={n}")

    # Rapid REST messages from Alpha
    with app.test_client() as c:
        # reclaim Alpha via resume
        r = c.post(
            "/api/auth/join-room",
            json={
                "room_id": rid,
                "password": pw,
                "display_name": "Alpha",
                "resume_token": tok_a,
            },
        )
        expect(r.status_code == 200, "stress_alpha_resume")
        tok_a = (r.get_json() or {})["session_token"]
        h = {"X-Session-Token": tok_a, "Content-Type": "application/json"}

        sent = 0
        limited = 0
        for i in range(50):
            r = c.post("/api/messages", headers=h, json={"ciphertext": f"burst.{i}." + ("m" * 40)})
            if r.status_code == 200:
                sent += 1
            elif r.status_code == 429:
                limited += 1
        expect(sent > 0, "stress_burst_some_delivered", f"sent={sent}")
        expect(limited > 0 or sent <= 30, "stress_burst_throttled_or_within_cap", f"sent={sent} lim={limited}")

        # Socket.IO rapid events
        client = socketio.test_client(app, flask_test_client=c, auth={"token": tok_a})
        expect(client.is_connected(), "stress_socket_connect")
        for i in range(60):
            client.emit("typing", {"typing": i % 2 == 0})
            client.emit("filmtv_control", {"action": "heartbeat", "position": float(i)})
        time.sleep(0.3)
        # Still connected after burst (rate limit drops events, should not crash)
        expect(client.is_connected(), "stress_socket_survives_burst")
        client.disconnect()

    # Parallel create same room id
    race_codes: list[int] = []

    def create_race(i: int) -> int:
        with app.test_client() as c:
            r = c.post(
                "/api/auth/create-room",
                json={
                    "room_id": f"race_{rid}",
                    "password": pw,
                    "display_name": f"Racer{i}",
                },
            )
            race_codes.append(r.status_code)
            return r.status_code

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(create_race, range(12)))
    created = sum(1 for s in race_codes if s == 200)
    expect(created == 1, "stress_single_room_create_wins", f"created={created} codes={race_codes}")


def main() -> int:
    print("Ipsita-Sathi 3-Stage Simulation")
    print("=" * 40)
    app = create_app()
    # Isolate DB for sim if possible — use existing instance DB with unique room ids
    try:
        stage1_normal(app)
        stage2_chaotic(app)
        stage3_stress(app)
    except Exception as e:
        bad("fatal_exception", f"{e}\n{traceback.format_exc()}")

    print("\n═══ SUMMARY ═══")
    print(f"Passed: {PASS}")
    print(f"Failed: {FAIL}")
    print(f"Total:  {PASS + FAIL}")
    if FAIL:
        print("\nFailed cases:")
        for name, good, detail in RESULTS:
            if not good:
                print(f"  - {name}: {detail}")
        return 1
    print("\nALL STAGES PASSED — app ready under normal, chaotic, and stress usage.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
