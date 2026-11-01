#!/bin/sh
# Installs PixelForge as a systemd *user* service that starts at login.
# Optional environment: PIXELFORGE_DIR, PORT, HOST, PIXELFORGE_ALLOW_REGISTRATION.
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this installer as your normal user, not root or with sudo, so the service starts in your user session." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found. Start PixelForge with ./start-linux.sh instead." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
APP_DIR="${PIXELFORGE_DIR:-$SCRIPT_DIR}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pixelforge"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/pixelforge.service"
PORT="${PORT:-4173}"
HOST="${HOST:-127.0.0.1}"
ALLOW_REGISTRATION="${PIXELFORGE_ALLOW_REGISTRATION:-1}"

if [ ! -f "$APP_DIR/package.json" ] || [ ! -f "$APP_DIR/server.mjs" ]; then
  echo "PixelForge was not found in $APP_DIR. Run this script from the project folder or set PIXELFORGE_DIR." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.13+ with npm is required. Install it, then run this script again." >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)'; then
  echo "PixelForge requires Node.js 22.13 or later (found $(node -v))." >&2
  exit 1
fi

NODE_BIN=$(command -v node)
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
mkdir -p "$DATA_DIR" "$SERVICE_DIR"
chmod 700 "$DATA_DIR"

# systemd needs quoted paths when they contain spaces.
cat >"$SERVICE_FILE" <<UNIT
[Unit]
Description=PixelForge display editor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment="PIXELFORGE_DATA_DIR=$DATA_DIR"
Environment=PORT=$PORT
Environment=HOST=$HOST
Environment=PIXELFORGE_ALLOW_REGISTRATION=$ALLOW_REGISTRATION
ExecStart="$NODE_BIN" "$APP_DIR/server.mjs"
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable pixelforge.service
systemctl --user restart pixelforge.service

echo "PixelForge is running at http://localhost:$PORT and will start at login."
echo "Logs:   journalctl --user -u pixelforge -f"
echo "Stop:   systemctl --user disable --now pixelforge"
echo "To keep it running without an active login (e.g. on a headless server): sudo loginctl enable-linger $(id -un)"
