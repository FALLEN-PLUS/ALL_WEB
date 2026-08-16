@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================================
echo   Embedded Hardware Studio Platform
echo ========================================================
echo.
echo Starting unified web server on port 8000...
echo.

start "" "http://127.0.0.1:8000/"
python -m http.server 8000

pause
