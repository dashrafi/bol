@echo off
rem Bol — speak anywhere, it types. Double-click to start (lives in the system tray).
rem Dev launcher: runs from wherever this file sits, so the folder can move.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
