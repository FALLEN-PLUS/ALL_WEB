@echo off
echo Starting local web server for Web Serial API support...
echo Please ensure you are using Google Chrome or Microsoft Edge.
echo.

start http://127.0.0.1:8000
python -m http.server 8000

pause
