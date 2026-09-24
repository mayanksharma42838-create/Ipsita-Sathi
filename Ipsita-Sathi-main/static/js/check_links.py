import os
import re

# Project directories jo scan karni hain
TEMPLATE_FOLDER = "templates"  # Jahan HTML files hain
STATIC_FOLDER = "static"       # Jahan JS/CSS files hain
APP_FILE = "app.py"            # Main Flask file

def check_project_links():
    print("=== PROJECT LINK & ROUTE CHECKER ===")
    missing_items = []
    
    # 1. Check if main app and folders exist
    if not os.path.exists(APP_FILE):
        missing_items.append(f"Critical Missing File: {APP_FILE} nahi mila!")
    if not os.path.exists(TEMPLATE_FOLDER):
        missing_items.append(f"Missing Folder: '{TEMPLATE_FOLDER}' folder nahi mila!")
        
    # 2. Extract Flask routes from app.py
    flask_routes = set()
    if os.path.exists(APP_FILE):
        with open(APP_FILE, "r", encoding="utf-8") as f:
            content = f.read()
            # @app.route('/path') dhundne ke liye regex
            routes = re.findall(r"@app\.route\(['\"']([^'\"']+)['\"']\)", content)
            flask_routes.update(routes)
            print(f"-> Flask routes found in {APP_FILE}: {list(flask_routes)}")

    # 3. Check HTML templates for missing endpoints or assets
    if os.path.exists(TEMPLATE_FOLDER):
        for root, dirs, files in os.walk(TEMPLATE_FOLDER):
            for file in files:
                if file.endswith(".html"):
                    filepath = os.path.join(root, file)
                    with open(filepath, "r", encoding="utf-8") as tf:
                        t_content = tf.read()
                        
                        # Check for url_for missing endpoints inside templates
                        url_fors = re.findall(r"url_for\(['\"']([^'\"']+)['\"']\)", t_content)
                        for uf in url_fors:
                            if uf != 'static' and uf not in [r.strip('/') for r in flask_routes]:
                                missing_items.append(f"HTML Template ({file}): url_for('{uf}') ka route app.py mein defined nahi hai!")

    # Final Report
    print("\n=== SCAN REPORT ===")
    if missing_items:
        print("Yeh missing links/issues pakde gaye hain:")
        for item in missing_items:
            print(f" [X] {item}")
    else:
        print(" [V] Sabhi routes aur links ekdum sahi jagah linked hain, koi missing link nahi mila!")

if __name__ == "__main__":
    check_project_links()