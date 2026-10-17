#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this installer as the desktop user, not root or with sudo, so the service starts in the correct user session." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
APP_DIR="${PIXELFORGE_DIR:-$SCRIPT_DIR}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pixelforge"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/pixelforge.service"

if [ ! -f "$APP_DIR/package.json" ] || [ ! -f "$APP_DIR/server.mjs" ]; then
  echo "PixelForge was not found in $APP_DIR. Run this script from the project copy or set PIXELFORGE_DIR to the project folder." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js 22.12+ (including npm), then run this script again." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  echo "PixelForge requires Node.js 22.12 or later." >&2
  exit 1
fi

cd "$APP_DIR"
if [ ! -d node_modules ]; then
  npm install
fi
npm run build
mkdir -p "$DATA_DIR" "$SERVICE_DIR"

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=PixelForge display editor
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PIXELFORGE_DATA_DIR=$DATA_DIR
ExecStart=$(command -v node) $APP_DIR/server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now pixelforge.service
echo "PixelForge will start at login and is available at http://localhost:4173"
