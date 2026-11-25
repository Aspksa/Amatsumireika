@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
where python >nul 2>&1
if errorlevel 1 goto missing
if exist dist\app.js goto run
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing
call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto failed
call npm.cmd run build
if errorlevel 1 goto failed
:run
python server.py --open
if errorlevel 1 goto failed
exit /b 0
:missing
echo Python 3 and Node.js/npm are required for the initial build.
:failed
pause
exit /b 1
