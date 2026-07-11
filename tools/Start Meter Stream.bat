@echo off
REM Fallback double-click launcher (shows a brief console). Prefer the .vbs.
cd /d "%~dp0"
start "" ".venv\Scripts\pythonw.exe" "meter_gui.py"
