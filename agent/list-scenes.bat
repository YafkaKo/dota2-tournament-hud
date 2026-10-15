@echo off
chcp 65001 >nul
title Сцены OBS
cd /d "%~dp0"

if exist node_modules goto run
call npm install

:run
node agent.js --list-scenes
pause
