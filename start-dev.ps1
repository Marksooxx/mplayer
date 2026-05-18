#!/usr/bin/env pwsh
# mplayer dev launcher (PowerShell)
# 双击 start-dev.bat 会调用本脚本；也可直接右键「使用 PowerShell 运行」。

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Write-Step { param([string]$Msg) Write-Host "[step] $Msg" -ForegroundColor Cyan }
function Write-Info { param([string]$Msg) Write-Host "[info] $Msg" -ForegroundColor Gray }
function Write-Ok   { param([string]$Msg) Write-Host "[ok]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[warn] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[err]  $Msg" -ForegroundColor Red }

function Fail {
    param([string]$Msg)
    Write-Err $Msg
    Read-Host "按 Enter 退出"
    exit 1
}

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  mplayer dev launcher" -ForegroundColor Cyan
Write-Host "  working dir : $(Get-Location)" -ForegroundColor Gray
Write-Host "  pwsh version: $($PSVersionTable.PSVersion)" -ForegroundColor Gray
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 环境检查
$pnpm  = Get-Command pnpm  -ErrorAction SilentlyContinue
$node  = Get-Command node  -ErrorAction SilentlyContinue
$cargo = Get-Command cargo -ErrorAction SilentlyContinue

if (-not $node)  { Fail "node 未找到。请确认 fnm 已激活：fnm use 22 (或安装 https://nodejs.org/)" }
if (-not $pnpm)  { Fail "pnpm 未找到。请运行：npm i -g pnpm" }
if (-not $cargo) { Fail "cargo 未找到。请安装 Rust toolchain：https://rustup.rs/" }

Write-Ok "node  $((& node --version))  @ $($node.Source)"
Write-Ok "pnpm  $((& pnpm --version))  @ $($pnpm.Source)"
Write-Ok "cargo $((& cargo --version | Select-Object -First 1))"
Write-Host ""

# 2. 依赖检查
if (-not (Test-Path "node_modules")) {
    Write-Step "node_modules 缺失，执行 pnpm install ..."
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install 失败" }
} else {
    Write-Info "node_modules 已存在"
}

# 3. libmpv DLL 检查
$dllPath = Join-Path $PSScriptRoot "src-tauri\lib\libmpv-2.dll"
if (-not (Test-Path $dllPath)) {
    Write-Step "libmpv DLL 缺失，下载 libmpv-2.dll 与 wrapper（约 100MB）..."
    & node "node_modules\tauri-plugin-libmpv-api\dist-js\cli.cjs" setup-lib
    if ($LASTEXITCODE -ne 0) { Fail "libmpv DLL 下载失败，请检查网络后重试" }
} else {
    Write-Info "libmpv DLL 已就位"
}

# 4. 启动开发服务
Write-Host ""
Write-Step "启动 pnpm tauri dev"
Write-Info "首次运行需要编译 Rust 依赖，耗时约 3-10 分钟，请耐心等待"
Write-Host ""

& pnpm tauri dev
exit $LASTEXITCODE
