#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js 22.12+ (including npm), then run this script again." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  echo "PixelForge requires Node.js 22.12 or later." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

npm run build
export NODE_ENV=production
echo "PixelForge is starting at http://localhost:4173"
exec npm start
