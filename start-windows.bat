@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22.12+ and try again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo PixelForge requires Node.js 22.12 or later.
  pause
  exit /b 1
)

if not exist "node_modules" (
  call npm install
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
