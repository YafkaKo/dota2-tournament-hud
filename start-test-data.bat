@echo off
chcp 65001 >nul
title Тестовые данные вместо Dota 2
cd /d "%~dp0"

echo Выберите, что имитировать:
echo   1 - матч в разгаре
echo   2 - стадия драфта
echo   3 - конец карты (итоги, потом выход в меню)
echo   4 - быстрая игра x10 с паузами (проверка сравнения вероятности)
echo   5 - новая карта с другим matchid
set /p mode=Номер: 

if "%mode%"=="2" goto draft
if "%mode%"=="3" goto ending
if "%mode%"=="4" goto fast
if "%mode%"=="5" goto newmatch
goto game

:draft
node tools\mock-gsi.js --draft
goto end

:ending
node tools\mock-gsi.js --end
goto end

:fast
node tools\mock-gsi.js --speed=10 --pause
goto end

:newmatch
node tools\mock-gsi.js --match=7900000002
goto end

:game
node tools\mock-gsi.js

:end
pause
