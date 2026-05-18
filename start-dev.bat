@echo off
chcp 65001 >nul
setlocal
title mplayer dev launcher
cd /d "%~dp0"

echo ===========================================
echo   mplayer dev launcher
echo   working dir: %CD%
echo ===========================================
echo.

where pnpm >nul 2>&1
if errorlevel 1 (
    echo [error] pnpm not found in PATH. Please install pnpm first: npm i -g pnpm
    pause
    exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
    echo [error] cargo not found in PATH. Please install Rust toolchain: https://rustup.rs/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [setup] node_modules missing, running pnpm install ...
    call pnpm install
    if errorlevel 1 (
        echo [error] pnpm install failed.
        pause
        exit /b 1
    )
)

if not exist "src-tauri\lib\libmpv-2.dll" (
    echo [setup] libmpv DLLs missing, downloading via setup-lib ...
    call node "node_modules\tauri-plugin-libmpv-api\dist-js\cli.cjs" setup-lib
    if errorlevel 1 (
        echo [error] libmpv DLL setup failed. Check network and retry.
        pause
        exit /b 1
    )
)

echo [run] pnpm tauri dev
echo (first run compiles Rust dependencies - this may take 3-10 minutes)
echo.
call pnpm tauri dev

endlocal
