import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
index_html_path = root / "templates" / "index.html"
js_dir = root / "static" / "js"
py_dir = root / "app"

index_html = index_html_path.read_text(encoding="utf-8")

# Extract all IDs in index.html
html_ids = set(re.findall(r'id=["\']([^"\']+)["\']', index_html))
html_classes = set(re.findall(r'class=["\']([^"\']+)["\']', index_html))

print(f"Total HTML IDs found in templates/index.html: {len(html_ids)}")

# Check JS files for DOM selectors
missing_ids = {}
for js_file in js_dir.glob("*.js"):
    code = js_file.read_text(encoding="utf-8")
    id_selectors = set(re.findall(r'\$\(["\']#([a-zA-Z0-9_-]+)["\']\)', code))
    id_selectors.update(re.findall(r'getElementById\(["\']([a-zA-Z0-9_-]+)["\']\)', code))
    
    for sel in id_selectors:
        if sel not in html_ids:
            if js_file.name not in missing_ids:
                missing_ids[js_file.name] = []
            missing_ids[js_file.name].append(sel)

print("\n--- Missing HTML IDs referenced in JS files ---")
for js_file, ids in sorted(missing_ids.items()):
    print(f"[{js_file}] -> {ids}")

# Check API routes
py_routes = set()
for py_file in py_dir.rglob("*.py"):
    code = py_file.read_text(encoding="utf-8")
    prefix = ""
    if 'url_prefix="/api/auth"' in code:
        prefix = "/api/auth"
    elif 'url_prefix="/api"' in code or 'bp = Blueprint("api"' in code:
        prefix = "/api"
        
    routes = re.findall(r'@(?:bp|api_bp|auth_bp|app)\.(?:route|get|post|delete|put)\(["\']([^"\']+)["\']', code)
    for r in routes:
        full_r = prefix + r if not r.startswith("/api") else r
        py_routes.add(full_r)

print(f"\nTotal Python Routes found: {len(py_routes)}")

# Check fetch/api calls in JS
js_fetches = {}
for js_file in js_dir.glob("*.js"):
    code = js_file.read_text(encoding="utf-8")
    fetches = re.findall(r'(?:fetch|api)\(["\'](/api/[^"\']+)["\']', code)
    for f in fetches:
        clean_f = f.split("?")[0]
        if clean_f not in js_fetches:
            js_fetches[clean_f] = []
        js_fetches[clean_f].append(js_file.name)

print("\n--- JS API Fetches vs Flask Backend Routes Check ---")
for fetch_url, files in sorted(js_fetches.items()):
    # Check match against py_routes or dynamic endpoints like /api/media/ or /api/messages/
    matched = False
    for pr in py_routes:
        if pr == fetch_url or fetch_url.startswith(pr.replace("<int:message_id>", "").replace("<message_id>", "")):
            matched = True
            break
    if not matched:
        print(f"❌ MISMATCH / MISSING ROUTE: {fetch_url} in {set(files)}")
    else:
        print(f"✓ Matched: {fetch_url}")

