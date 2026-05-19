#!/usr/bin/env pwsh
# 提高 Windows 资源管理器"多选按 Enter"的最大文件数限制
#
# Windows Shell 对多选文件按 Enter / 双击触发默认动词（open）有数量限制,
# 默认 15。超过则 Shell 静默拒绝执行 —— 表现为"选了 16+ 个视频按 Enter
# 没反应"。这个限制对所有传统 desktop 应用都生效（包括 mplayer/VLC/
# MPC-HC/PotPlayer 等),只有 UWP 系统播放器靠特殊 activation 通道绕过。
#
# 注册表键:HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer
#         → MultipleInvokePromptMinimum (DWORD,默认 15)
# 改 HKCU 不需要管理员权限,只影响当前用户。
#
# 用法:
#   .\raise-explorer-multi-limit.ps1                 # 默认提到 100,会询问是否重启 Explorer
#   .\raise-explorer-multi-limit.ps1 -Value 200      # 自定义值
#   .\raise-explorer-multi-limit.ps1 -AutoRestart    # 直接重启 Explorer,不询问
#   .\raise-explorer-multi-limit.ps1 -Reset          # 恢复 Windows 默认(删除注册表项,回到 15)

[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Value = 100,
    [switch]$Reset,
    [switch]$AutoRestart
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Msg) Write-Host "[step] $Msg" -ForegroundColor Cyan }
function Write-Info { param([string]$Msg) Write-Host "[info] $Msg" -ForegroundColor Gray }
function Write-Ok   { param([string]$Msg) Write-Host "[ok]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[warn] $Msg" -ForegroundColor Yellow }

$key  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer"
$name = "MultipleInvokePromptMinimum"

Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  Windows 资源管理器多选阈值调整" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

# 读当前值用于显示
$current = $null
try {
    $current = (Get-ItemProperty -Path $key -Name $name -ErrorAction Stop).$name
} catch {
    # 未设置过,使用 Windows 默认 15
}

if ($null -ne $current) {
    Write-Info "当前 $name = $current"
} else {
    Write-Info "当前未设置 (Windows 默认 = 15)"
}
Write-Host ""

# ----- 执行修改 -----
if ($Reset) {
    Write-Step "恢复默认:删除注册表项"
    if ($null -ne $current) {
        Remove-ItemProperty -Path $key -Name $name -Force
        Write-Ok "已删除 $name (恢复 Windows 默认 15)"
    } else {
        Write-Info "未设置过,无需操作"
    }
} else {
    if ($null -ne $current -and $current -eq $Value) {
        Write-Info "$name 已经是 $Value,无需重复设置"
    } else {
        Write-Step "设置 $name = $Value"
        New-ItemProperty -Path $key -Name $name -PropertyType DWord -Value $Value -Force | Out-Null
        Write-Ok "已设置 $key\$name = $Value"
    }
}

# ----- 重启 Explorer -----
Write-Host ""
$doRestart = $false
if ($AutoRestart) {
    $doRestart = $true
} else {
    Write-Host "重启 Explorer 立即生效? " -NoNewline -ForegroundColor Yellow
    Write-Host "[Y/n] " -NoNewline
    $ans = Read-Host
    if ($ans -eq "" -or $ans -match "^[Yy]") { $doRestart = $true }
}

if ($doRestart) {
    Write-Step "重启 explorer.exe"
    Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer
    }
    Write-Ok "Explorer 已重启,新阈值生效"
} else {
    Write-Warn "未重启 Explorer。注销重新登录,或手动重启 explorer.exe 后生效。"
}

Write-Host ""
Write-Info "现在选 $Value 个以下的视频按 Enter 可以一次性交给 mplayer 打开 (single-instance 转发会合并到同一窗口)"
