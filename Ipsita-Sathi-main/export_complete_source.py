"""Generate complete_source_code.md — full project source dump."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "complete_source_code.md"

EXCLUDE_NAMES = {"all_project_code.txt", "complete_source_code.md", "export_complete_source.py"}
EXCLUDE_DIRS = {
    ".venv",
    "node_modules",
    "instance",
    "media_storage",
    "__pycache__",
    ".git",
    "www",
    "android",
    "ios",
}
EXTS = {".py", ".js", ".html", ".css", ".json", ".md", ".txt"}
LANG = {
    ".py": "python",
    ".js": "javascript",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".md": "markdown",
    ".txt": "text",
}


def collect() -> list[Path]:
    files: list[Path] = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        if any(part in EXCLUDE_DIRS for part in p.parts):
            continue
        if p.name in EXCLUDE_NAMES:
            continue
        if p.suffix.lower() not in EXTS:
            continue
        files.append(p)
    return sorted(files, key=lambda x: x.as_posix().lower())


def main() -> None:
    files = collect()
    lines: list[str] = [
        "# Ipsita-Sathi — Complete Source Code",
        "",
        "Single consolidated dump of every project source file with exact relative paths and full contents.",
        "",
        f"**Project root:** `Ipsita-Sathi-main/`",
        f"**File count:** {len(files)}",
        "",
        "## Table of contents",
        "",
    ]

    for i, p in enumerate(files, 1):
        rel = p.relative_to(ROOT).as_posix()
        lines.append(f"{i}. `{rel}`")

    lines += ["", "---", ""]

    for p in files:
        rel = p.relative_to(ROOT).as_posix()
        lang = LANG.get(p.suffix.lower(), "")
        try:
            content = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = p.read_text(encoding="utf-8", errors="replace")

        lines.append(f"## File: `{rel}`")
        lines.append("")
        lines.append(f"- **Path:** `{rel}`")
        lines.append(f"- **Name:** `{p.name}`")
        lines.append("")
        lines.append(f"```{lang}")
        lines.append(content.rstrip("\n"))
        lines.append("```")
        lines.append("")
        lines.append("---")
        lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {OUT.name} ({OUT.stat().st_size:,} bytes)")
    for p in files:
        print(f"  - {p.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
