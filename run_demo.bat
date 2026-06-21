@echo off
echo Starting Grocery Agent in DEMO MODE (port 5001)...
echo Live server on port 5000 is unaffected.
echo.
python server.py --demo %*
pause
