#Requires -Version 5.1
<#
.SYNOPSIS
  AI 音乐工作室 — 用户级卸载程序（幂等，可重复运行）。

.DESCRIPTION
  删除安装目录、桌面/开始菜单快捷方式与 HKCU 卸载项。
  用户数据（%APPDATA%\AI音乐工作室）默认保留；确需删除时显式传 -RemoveUserData。

.PARAMETER InstallDir
  安装目录。省略时读取 HKCU 卸载项里的 InstallLocation；再缺省时用默认路径。

.PARAMETER KeepUserData
  保留用户数据（默认行为；提供该开关以便显式声明）。

.PARAMETER RemoveUserData
  同时删除用户数据（%APPDATA%\AI音乐工作室）：工程/导出/媒体都会丢失，请谨慎。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Uninstall.ps1
  默认卸载并保留用户数据。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Uninstall.ps1 -RemoveUserData
  卸载并删除用户数据。
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [switch]$KeepUserData,
  [switch]$RemoveUserData
)

$ErrorActionPreference = 'Stop'
$AppName = 'AI音乐工作室'
$AppId = 'AI音乐工作室'
$ExeName = "$AppName.exe"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppId"
$UserDataDir = Join-Path $env:APPDATA $AppName

function Write-Step([string]$Text) { Write-Host "[卸载] $Text" }

try {
  Write-Step "AI 音乐工作室 卸载程序"

  # 1) 解析安装目录：参数 > 注册表 > 默认路径
  if (-not $InstallDir) {
    if (Test-Path -LiteralPath $UninstallKey) {
      try {
        $InstallDir = [string](Get-ItemProperty -Path $UninstallKey -Name 'InstallLocation' -ErrorAction Stop).InstallLocation
      } catch {
        $InstallDir = ''
      }
    }
  }
  if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\AI音乐工作室'
  }
  Write-Step "安装目录：$InstallDir"

  # 2) 结束安装目录中正在运行的应用（其它位置的实例不动；用户数据保留）
  $running = Get-Process -Name $AppName -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path -like "$InstallDir*")
  }
  if ($running) {
    Write-Step "正在关闭安装目录中的应用…"
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }

  # 3) 删除快捷方式（桌面 + 开始菜单）
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
    foreach ($lnk in @((Join-Path $desktop "$AppName.lnk"), (Join-Path $startMenu "$AppName.lnk"))) {
      if (Test-Path -LiteralPath $lnk) {
        Remove-Item -LiteralPath $lnk -Force
        Write-Step "已删除快捷方式：$lnk"
      }
    }
  } catch {
    Write-Step "提示：删除快捷方式失败（$($_.Exception.Message)）"
  }

  # 4) 删除 HKCU 卸载项
  if (Test-Path -LiteralPath $UninstallKey) {
    Remove-Item -Path $UninstallKey -Recurse -Force
    Write-Step "已删除当前用户卸载项。"
  }

  # 5) 删除安装目录
  if (Test-Path -LiteralPath $InstallDir) {
    try {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force
      Write-Step "已删除安装目录：$InstallDir"
    } catch {
      # 被占用时重试一次
      Start-Sleep -Milliseconds 1200
      Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
      Write-Step "已删除安装目录（重试成功）：$InstallDir"
    }
  } else {
    Write-Step "安装目录不存在，跳过。"
  }

  # 6) 用户数据：默认保留
  if ($RemoveUserData) {
    if (Test-Path -LiteralPath $UserDataDir) {
      Remove-Item -LiteralPath $UserDataDir -Recurse -Force
      Write-Step "已删除用户数据：$UserDataDir"
    } else {
      Write-Step "用户数据目录不存在，跳过。"
    }
  } elseif (Test-Path -LiteralPath $UserDataDir) {
    Write-Step "已保留用户数据：$UserDataDir（如需彻底删除请传 -RemoveUserData）"
  }

  Write-Step "卸载完成。"
  exit 0
} catch {
  Write-Host "[卸载失败] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
