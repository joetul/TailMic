@echo off
title TailMic update
rem ONE line on purpose: the update replaces this very file while it runs, and
rem cmd.exe must not go on reading commands from the new one.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" & echo. & pause & exit /b
