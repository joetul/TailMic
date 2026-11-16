@echo off
title TailMic status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\status.ps1"
echo.
pause
