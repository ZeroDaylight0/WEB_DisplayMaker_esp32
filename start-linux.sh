#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js 20, 22, or 24+ (including npm), then run this script again. Node.js 22 LTS is recommended." >&2
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major === 20 || major === 22 || major >= 24 ? 0 : 1)'; then
  echo "PixelForge requires Node.js 20, 22, or 24+. Node.js 21 and 23 are not supported by its build dependencies; use Node.js 22 LTS." >&2
  exit 1
fi

if [ ! -d node_modules ] || ! node -e 'require("better-sqlite3")' >/dev/null 2>&1; then
  npm ci
fi

npm run build
export NODE_ENV=production
echo "PixelForge is starting at http://localhost:4173"
exec npm start
