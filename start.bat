@echo off
rem HUD server. Keep this window open during the broadcast.
rem Only ASCII here: Cyrillic in .bat files breaks cmd.exe on some Windows versions.
title HUD server - do not close during broadcast
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if exist node_modules goto run
echo.
echo First run: installing dependencies, please wait...
echo.
call npm install
if errorlevel 1 goto installfail

:run
node server\index.js
pause
exit /b 0

:nonode
echo.
echo Node.js not found on this PC.
echo Install Node.js 18 or newer (LTS) from https://nodejs.org
echo then close this window and run the file again.
echo.
pause
exit /b 1

:installfail
echo.
echo "npm install" failed. Check the internet connection and Node.js version (node -v).
echo.
pause
exit /b 1
