@echo off
rem TailMic command line - works at the desktop and over SSH:
rem   TailMic start    start TailMic (over SSH it starts on your desktop session)
rem   TailMic stop     close the TailMic window and server
rem   TailMic status   show whether TailMic is ready
rem   TailMic set-user you@example.com   change the allowed Tailscale user
setlocal
set "PS=powershell.exe -NoProfile -ExecutionPolicy Bypass -File"
if /i "%~1"=="start"  goto start
if /i "%~1"=="stop"   goto stop
if /i "%~1"=="status" goto status
if /i "%~1"=="set-user" goto setuser
echo Usage: TailMic start ^| stop ^| status ^| set-user ^<Tailscale login^>
exit /b 2
:start
%PS% "%~dp0scripts\start.ps1"
exit /b %errorlevel%
:stop
%PS% "%~dp0scripts\stop.ps1"
exit /b %errorlevel%
:status
%PS% "%~dp0scripts\status.ps1"
exit /b %errorlevel%
:setuser
%PS% "%~dp0scripts\set-user.ps1" "%~2" %3
exit /b %errorlevel%
