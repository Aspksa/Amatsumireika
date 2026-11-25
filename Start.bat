@echo off
setlocal DisableDelayedExpansion
title Amatsumireika - Local server
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
pushd "%~dp0" || goto failed
echo.
echo  AMATSUMIREIKA / LOCAL SYSTEM
echo  ---------------------------
py -3 -c "import sys;sys.exit(sys.version_info < (3,10))" >nul 2>&1
if not errorlevel 1 goto use_py
python -c "import sys;sys.exit(sys.version_info < (3,10))" >nul 2>&1
if not errorlevel 1 goto use_python
echo [ERROR] Python 3.10 or newer is required.
popd
goto failed
:use_py
py -3 -u launcher.py %*
goto result
:use_python
python -u launcher.py %*
:result
set "EXITCODE=%ERRORLEVEL%"
popd
if "%EXITCODE%"=="0" exit /b 0
:failed
echo [ERROR] Startup failed. See data\startup.log if available.
echo Your SQLite database was not deleted.
if /i "%~1"=="--check" exit /b 1
pause
exit /b 1
