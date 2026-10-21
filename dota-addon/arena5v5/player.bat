@echo off
rem ===========================================================================
rem  Player PC: start Dota and connect to the Arena 5x5 host.
rem      player.bat 192.168.1.50
rem      player.bat 192.168.1.50 "D:\SteamLibrary\steamapps\common\dota 2 beta"
rem  If after connecting there is no team/draft screen, add -tools to the
rem  start line below (the client will then build the custom UI itself).
rem ===========================================================================
set "HOST=%~1"
if "%HOST%"=="" set /p HOST=Host IP: 
set "DOTA=%~2"
if "%DOTA%"=="" set "DOTA=C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta"
start "" "%DOTA%\game\bin\win64\dota2.exe" -addon arena5v5 -novid -console -language russian +connect %HOST%
