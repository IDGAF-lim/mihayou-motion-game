@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-private-network.ps1"
if errorlevel 1 pause
