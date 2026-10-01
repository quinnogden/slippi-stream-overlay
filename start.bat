@echo off
rem Starts the stream app: the dock at http://localhost:5001/dock, every
rem overlay under /o/, the start.gg event and the Slippi folder watch.
rem Double-click it, or pin a shortcut to it. Closing this window stops it.
title Stream app
cd /d "%~dp0slippi-bridge"

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
)

node index.js
echo.
echo The app has stopped. If it stopped on its own, the reason is above;
echo "node scripts\preflight.js" in slippi-bridge\ checks the whole setup.
pause
