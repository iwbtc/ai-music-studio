#Requires -Version 5.1
<#
.SYNOPSIS
  AI 音乐工作室 — 用户级安装程序（无需管理员）。

.DESCRIPTION
  把应用文件复制到 %LOCALAPPDATA%\Programs\AI音乐工作室（可用 -InstallDir 覆盖），
  创建桌面/开始菜单快捷方式，写 HKCU 卸载项，然后可选启动应用。
  用户数据（%APPDATA%\AI音乐工作室）默认保留，升级/卸载不会删除。

.PARAMETER InstallDir
  安装目录。默认 %LOCALAPPDATA%\Programs\AI音乐工作室。

.PARAMETER SourceDir
  应用文件所在目录。默认本脚本所在目录（自解压安装包解压后的临时目录）。

.PARAMETER NoShortcuts
  不创建桌面/开始菜单快捷方式（自动化测试/便携场景）。

.PARAMETER NoLaunch
  安装完成后不启动应用（自动化测试）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Install.ps1
  默认安装并启动。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Install.ps1 -InstallDir D:\Apps\AI音乐工作室 -NoShortcuts -NoLaunch
  指定目录安装，不建快捷方式、不启动（测试用）。
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AI音乐工作室'),
  [string]$SourceDir = $PSScriptRoot,
  [switch]$NoShortcuts,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$AppName = 'AI音乐工作室'
$AppId = 'AI音乐工作室'
$Publisher = 'AI 音乐工作室'
$ExeName = "$AppName.exe"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppId"

function Write-Step([string]$Text) { Write-Host "[安装] $Text" }
function Fail([string]$Message) {
  Write-Host "[安装失败] $Message" -ForegroundColor Red
  exit 1
}

try {
  Write-Step "AI 音乐工作室 安装程序"
  Write-Step "安装目录：$InstallDir"

  # 1) 校验来源
  $sourceExe = Join-Path $SourceDir $ExeName
  if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    $nested = Join-Path $SourceDir 'app'
    $nestedExe = Join-Path $nested $ExeName
    if (Test-Path -LiteralPath $nestedExe -PathType Leaf) {
      $SourceDir = $nested
      $sourceExe = $nestedExe
    }
  }
  if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    Fail "安装包不完整：找不到 $ExeName（来源目录 $SourceDir）。请重新下载安装包。"
  }

  # 2) 读取版本（构建脚本生成的 installer-meta.json；缺失时回退 1.0.0）
  $version = '1.0.0'
  $metaPath = Join-Path $SourceDir 'installer-meta.json'
  if (Test-Path -LiteralPath $metaPath -PathType Leaf) {
    try {
      $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($meta.version) { $version = [string]$meta.version }
    } catch {
      Write-Step "提示：installer-meta.json 解析失败，版本回退 $version"
    }
  }

  # 3) 目标目录：已安装则覆盖升级（保留用户数据），不删除安装目录以外的文件
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path

  # 仅当「目标安装位置的应用」正在运行时才中止（其它位置的实例不影响本次安装）
  $targetExeCandidate = Join-Path $InstallDir $ExeName
  $running = Get-Process -Name $AppName -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path -ieq $targetExeCandidate)
  }
  if ($running) {
    Write-Step "检测到目标位置的应用正在运行：$targetExeCandidate"
    Write-Step "请先关闭该窗口后重试安装（用户数据不会丢失）。"
    Fail "目标应用正在运行，已取消安装。"
  }

  # 4) 复制文件（覆盖已有文件；排除安装脚本以外的临时文件）
  Write-Step "正在复制应用文件（约 360MB，请稍候）…"
  $exclude = @('installer-config.txt', 'installer-meta.json', 'Install.ps1', 'Uninstall.ps1')
  Get-ChildItem -LiteralPath $SourceDir -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $InstallDir -Recurse -Force
  }

  # 安装脚本与卸载脚本复制到安装目录（供卸载入口使用）
  foreach ($scriptName in @('Install.ps1', 'Uninstall.ps1')) {
    $scriptSrc = Join-Path $PSScriptRoot $scriptName
    if (Test-Path -LiteralPath $scriptSrc -PathType Leaf) {
      Copy-Item -LiteralPath $scriptSrc -Destination (Join-Path $InstallDir $scriptName) -Force
    }
  }
  $targetExe = Join-Path $InstallDir $ExeName
  if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) {
    Fail "复制完成但未找到 $targetExe，安装中止。"
  }

  # 5) 快捷方式（桌面 + 开始菜单），可用 -NoShortcuts 跳过
  if (-not $NoShortcuts) {
    try {
      $wsh = New-Object -ComObject WScript.Shell
      $shortcutTargets = @()
      $desktop = [Environment]::GetFolderPath('Desktop')
      if ($desktop) { $shortcutTargets += (Join-Path $desktop "$AppName.lnk") }
      $startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
      if ($startMenu) { $shortcutTargets += (Join-Path $startMenu "$AppName.lnk") }
      foreach ($lnk in $shortcutTargets) {
        $shortcut = $wsh.CreateShortcut($lnk)
        $shortcut.TargetPath = $targetExe
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.IconLocation = "$targetExe,0"
        $shortcut.Description = 'AI 音乐工作室 — AI 电子音乐工作站'
        $shortcut.Save()
      }
      Write-Step "已创建桌面/开始菜单快捷方式。"
    } catch {
      Write-Step "提示：快捷方式创建失败（$($_.Exception.Message)），应用仍可使用。"
    }
  } else {
    Write-Step "已跳过快捷方式（-NoShortcuts）。"
  }

  # 6) HKCU 卸载项（当前用户，无需管理员）
  try {
    if (-not (Test-Path -LiteralPath $UninstallKey)) {
      New-Item -Path $UninstallKey -Force | Out-Null
    }
    $uninstallScript = Join-Path $InstallDir 'Uninstall.ps1'
    $uninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstallScript`""
    New-ItemProperty -Path $UninstallKey -Name 'DisplayName' -Value "AI 音乐工作室" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'DisplayVersion' -Value $version -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'Publisher' -Value $Publisher -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'InstallLocation' -Value $InstallDir -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'UninstallString' -Value $uninstallString -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'DisplayIcon' -Value $targetExe -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'EstimatedSize' -Value 0 -PropertyType DWord -Force | Out-Null
    Write-Step "已写入当前用户卸载项（设置 → 应用 中可卸载）。"
  } catch {
    Write-Step "提示：卸载项写入失败（$($_.Exception.Message)），不影响使用。"
  }

  Write-Step "安装完成：版本 $version，位置 $InstallDir"
  Write-Step "用户数据位于 %APPDATA%\AI音乐工作室（卸载时默认保留）。"

  # 7) 启动（-NoLaunch 跳过）
  if (-not $NoLaunch) {
    Write-Step "正在启动 AI 音乐工作室…"
    Start-Process -FilePath $targetExe -WorkingDirectory $InstallDir | Out-Null
  } else {
    Write-Step "已跳过启动（-NoLaunch）。"
  }

  exit 0
} catch {
  Fail "未预期的错误：$($_.Exception.Message)"
}
