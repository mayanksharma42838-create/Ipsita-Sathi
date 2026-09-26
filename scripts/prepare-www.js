/**
 * Copies a minimal Capacitor web shell. Production mobile builds should
 * point capacitor.config.json server.url at your Flask host (LAN/HTTPS).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const www = path.join(root, "www");
fs.mkdirSync(www, { recursive: true });

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Ipsita-Sathi</title>
  <style>
    body { font-family: system-ui; background:#1a0f14; color:#fce8ef; display:flex; min-height:100vh; align-items:center; justify-content:center; text-align:center; padding:24px; }
    a { color:#ff8fab; }
  </style>
</head>
<body>
  <div>
    <h1>Ipsita-Sathi</h1>
    <p>Native shell ready. Configure <code>capacitor.config.json</code> <code>server.url</code> to your Flask server, then run <code>npx cap sync</code>.</p>
    <p>Default Android emulator host: <a href="http://10.0.2.2:5000">http://10.0.2.2:5000</a></p>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(www, "index.html"), html);
console.log("Prepared www/ for Capacitor");
