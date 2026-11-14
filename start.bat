@echo off
title GreenChat
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Telecharge la version LTS sur https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installation des dependances...
  call npm install --omit=dev
)
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:3500"
node server.js
pause
