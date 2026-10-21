@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  Arena 5x5 custom game installer (Dota 2 Workshop Tools).
rem  Run on EVERY PC: host, players, broadcast PC.
rem  Dota in another library:  install.bat "D:\SteamLibrary\steamapps\common\dota 2 beta"
rem ===========================================================================

set "DOTA=%~1"
if not "%DOTA%"=="" goto found

for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Valve\Steam" /v SteamPath 2^>nul ^| find "SteamPath"') do set "STEAM=%%b"
if defined STEAM set "STEAM=%STEAM:/=\%"
if defined STEAM if exist "%STEAM%\steamapps\common\dota 2 beta\game\dota" set "DOTA=%STEAM%\steamapps\common\dota 2 beta"
if "%DOTA%"=="" if exist "C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta\game\dota" set "DOTA=C:\Program Files (x86)\Steam\steamapps\common\dota 2 beta"

if "%DOTA%"=="" (
  echo Dota 2 folder not found. Pass it explicitly:
  echo   install.bat "D:\SteamLibrary\steamapps\common\dota 2 beta"
  pause
  exit /b 1
)

:found
if not exist "%DOTA%\game\dota" (
  echo "%DOTA%" has no game\dota subfolder - this is not the Dota 2 folder.
  pause
  exit /b 1
)

echo Dota 2: %DOTA%
if not exist "%DOTA%\game\bin\win64\resourcecompiler.exe" (
  echo.
  echo WARNING: Dota 2 Workshop Tools not found.
  echo Steam - Library - Dota 2 - Properties - DLC - enable "Dota 2 Workshop Tools DLC".
  echo.
)

robocopy "%~dp0game" "%DOTA%\game\dota_addons\arena5v5" /E /NFL /NDL /NJH /NJS /XF *_c >nul
robocopy "%~dp0content" "%DOTA%\content\dota_addons\arena5v5" /E /NFL /NDL /NJH /NJS >nul

echo.
echo Done. Installed to:
echo   %DOTA%\game\dota_addons\arena5v5
echo   %DOTA%\content\dota_addons\arena5v5
echo.
echo Settings (HUD address, draft, observer):
echo   %DOTA%\game\dota_addons\arena5v5\scripts\vscripts\arena\config.lua
echo.
pause
