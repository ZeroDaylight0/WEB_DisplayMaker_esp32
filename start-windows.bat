@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22.13+ from https://nodejs.org and try again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=13?0:1)"
if errorlevel 1 (
  echo PixelForge requires Node.js 22.13 or later.
  pause
  exit /b 1
)

if not exist node_modules (
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto failed
)

call npm run build
if errorlevel 1 goto failed

set NODE_ENV=production
node server.mjs
if errorlevel 1 goto failed
exit /b 0

:failed
echo PixelForge could not start. Review the error above.
pause
exit /b 1
