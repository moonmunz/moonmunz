@echo off
REM Double-click this file to start the app.
REM The first run takes a minute while it installs; after that it's a few seconds.

cd /d "%~dp0"

echo.
echo   Auction Spread Finder
echo   ---------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js isn't installed yet.
  echo.
  echo   1. Go to  https://nodejs.org
  echo   2. Download the big green LTS button and run the installer.
  echo   3. Come back and double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run - installing ^(about a minute^)...
  call npm install --silent
  if errorlevel 1 (
    echo   Install failed.
    pause
    exit /b 1
  )
  echo   Done.
  echo.
)

echo   Starting. Your browser will open in a moment.
echo   Keep this window open while you use the app.
echo   Close it or press Ctrl+C when you're done.
echo.

REM Give the server a moment to bind before opening the browser.
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:4317"

call npm start
