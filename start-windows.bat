@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20+ and try again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo PixelForge requires Node.js 20 or later.
  pause
  exit /b 1
)

node -e "require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  call npm ci
  if errorlevel 1 goto failed
)

call npm run build
if errorlevel 1 goto failed

set NODE_ENV=production
echo PixelForge is starting at http://localhost:4173
call npm start
if errorlevel 1 goto failed
exit /b 0

:failed
echo PixelForge could not start. Review the error above.
pause
exit /b 1
