@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
where python >nul 2>&1
if errorlevel 1 goto missing
python frontend_build.py
if not errorlevel 1 goto run
echo Frontend is missing, outdated or damaged. Rebuilding...
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing
if exist node_modules\typescript\bin\tsc goto build
call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto failed
:build
call npm.cmd run build
if errorlevel 1 goto failed
python frontend_build.py --seal
if errorlevel 1 goto failed
:run
python server.py --open
if errorlevel 1 goto failed
exit /b 0
:missing
echo Python 3 and Node.js/npm are required to rebuild this version.
:failed
echo Startup failed. Check the messages above. Your database was not deleted.
pause
exit /b 1
