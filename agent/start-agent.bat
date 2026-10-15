@echo off
chcp 65001 >nul
title Агент хоткеев трансляции
cd /d "%~dp0"

if exist node_modules goto run

echo.
echo Первый запуск: ставлю зависимости агента...
echo.
call npm install
if errorlevel 1 goto installfail
goto run

:installfail
echo.
echo Не удалось поставить зависимости. Проверьте, что установлен Node.js 18+.
echo.
pause
exit /b 1

:run
node agent.js
pause
