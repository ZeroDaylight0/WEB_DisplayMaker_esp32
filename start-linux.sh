#!/bin/sh
# Builds (when needed) and starts PixelForge on Linux/macOS.
# Environment: PORT (default 4173), HOST (default 127.0.0.1; use 0.0.0.0 for LAN access),
#              PIXELFORGE_DATA_DIR, PIXELFORGE_ALLOW_REGISTRATION=0 to disable sign-ups.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.13+ with npm is required. Install it from https://nodejs.org or with nvm, then run this script again." >&2
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)'; then
  echo "PixelForge requires Node.js 22.13 or later (found $(node -v))." >&2
  exit 1
fi

if [ ! -f node_modules/.package-lock.json ] || [ -n "$(find package-lock.json -newer node_modules/.package-lock.json)" ]; then
  npm ci --no-audit --no-fund
fi

# Rebuild only when the editor sources changed since the last build.
if [ ! -f dist/index.html ] || [ -n "$(find src public index.html vite.config.ts package.json -newer dist/index.html 2>/dev/null | head -n 1)" ]; then
  npm run build
fi

export NODE_ENV=production
exec node server.mjs
