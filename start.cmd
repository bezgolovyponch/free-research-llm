@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org/en/download & pause & exit /b 1)
if not exist node_modules (call npm install || (pause & exit /b 1))
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:4600"
node src\frl.mjs start
