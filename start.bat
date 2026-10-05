@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page - install the LTS version, then double-click this file again.
  start https://nodejs.org/en/download
  pause
  exit /b
)
echo Starting Concern Desk... keep this window open. Close it to stop the server.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
