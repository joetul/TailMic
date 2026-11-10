@echo off
title TailMic
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
if errorlevel 1 pause
timeout /t 4 >nul
