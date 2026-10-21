#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js 20+ (including npm), then run this script again." >&2
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "PixelForge requires Node.js 20 or later." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

npm run build
export NODE_ENV=production
echo "PixelForge is starting at http://localhost:4173"
exec npm start
