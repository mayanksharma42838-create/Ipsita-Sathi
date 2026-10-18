import os
import sqlite3
from pathlib import Path

def run_deep_diagnostics():
    print("=" * 60)
    print("      IPSITA-SATHI: DEEP CODE & DATABASE DIAGNOSTIC")
    print("=" * 60)

    issues = []

    # 1. Check folder structure
    required_dirs = ["app", "app/blueprints", "static", "static/js", "static/css", "templates"]
    for d in required_dirs:
        if not os.path.exists(d):
            issues.append(f"Missing Directory: '{d}' folder nahi mila!")
        else:
            print(f" [✓] Directory found: {d}")

    # 2. Check essential files
    required_files = [
        "app/__init__.py", 
        "app/models.py", 
        "app/blueprints/auth.py", 
        "app/blueprints/api.py", 
        "app/sockets.py", 
        "static/js/app.js",
        "templates/index.html",
        "run.py"
    ]
    for f in required_files:
        if not os.path.exists(f):
            issues.append(f"Critical Missing File: '{f}' gayab hai!")
        else:
            print(f" [✓] File verified: {f}")

    # 3. Check Database & Tables (SQLite)
    db_path = Path("instance/ipsita_sathi.db")
    if not db_path.exists():
        print(" [!] Database file abhi nahi bani hai (App run karne par ban jayegi).")
    else:
        print(f" [✓] Database found at: {db_path}")
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = [row[0] for row in cursor.fetchall()]
            print(f" -> Tables in DB: {tables}")
            
            if "rooms" not in tables or "members" not in tables or "messages" not in tables:
                issues.append("Database Error: Kuch zaroori tables (rooms/members/messages) missing hain!")
            conn.close()
        except Exception as e:
            issues.append(f"Database Read Error: {e}")

    # Final Report
    print("\n" + "=" * 60)
    print("                  DIAGNOSTIC REPORT")
    print("=" * 60)
    if issues:
        print(f"❌ Found {len(issues)} potential issues / blockers:\n")
        for idx, err in enumerate(issues, 1):
            print(f"  {idx}. {err}")
    else:
        print("🎉 Code structure aur database ke lihaz se sab kuch ekdum fit hai!")
    print("=" * 60)

if __name__ == "__main__":
    run_deep_diagnostics()