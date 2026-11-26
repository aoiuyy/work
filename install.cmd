@echo off
setlocal
cd /d "%~dp0"
echo [Work v2.0.1] Khoi dong trinh cai dat tu dong...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
endlocal
