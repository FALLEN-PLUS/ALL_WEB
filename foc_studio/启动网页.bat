@echo off
cd /d "%~dp0"

set "WEB_URL=http://127.0.0.1:8000"
set "BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER_PATH%" goto launch

set "BROWSER_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if exist "%BROWSER_PATH%" goto launch

set "BROWSER_PATH=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER_PATH%" goto launch

set "BROWSER_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%BROWSER_PATH%" goto launch

echo Chrome or Edge was not found.
pause
exit /b 1

:launch
echo Starting G3507 FOC Web Serial tool...
echo Keep this window open while using the web page.
start "" "%BROWSER_PATH%" "%WEB_URL%"

py -m http.server 8000 --bind 127.0.0.1
if not errorlevel 1 exit /b 0

echo.
echo Failed to start the local server.
echo Check Python and make sure port 8000 is free.
pause
exit /b 1
