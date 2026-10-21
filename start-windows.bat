@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20, 22, or 24+ and try again. Node.js 22 LTS is recommended.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

node -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major === 20 || major === 22 || major >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo PixelForge requires Node.js 20, 22, or 24+. Node.js 21 and 23 are not supported by its build dependencies; use Node.js 22 LTS.
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
