@echo off
rem ===========================================================================
rem  Arena 5x5 host = broadcast PC (HUD server and OBS run here too).
rem  When Dota has loaded, open the console (~ or \) and type:
rem      dota_launch_custom_game arena5v5 dota
rem  Players connect with:  connect <IP of this PC>
rem  Dota in another library:  host.bat "D:\SteamLibrary\steamapps\common\dota 2 beta"
rem ===========================================================================
set "DOTA=%~1"
if "%DOTA%"=="" set "DOTA=C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta"
echo IP addresses of this PC (give one of them to the players):
ipconfig | findstr /c:"IPv4"
echo.
echo In the Dota console type:  dota_launch_custom_game arena5v5 dota
start "" "%DOTA%\game\bin\win64\dota2.exe" -tools -addon arena5v5 -novid -console -language russian
pause
