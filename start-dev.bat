@echo off
chcp 65001 >nul
title mplayer dev launcher
cd /d "%~dp0"

REM Delegate to PowerShell so user's fnm/pnpm/cargo profile is honored
where pwsh >nul 2>&1
if %errorlevel%==0 (
    pwsh -NoLogo -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
) else (
    powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
)

if errorlevel 1 (
    echo.
    echo [launcher] exit code %errorlevel%
    pause
)
