$ErrorActionPreference = 'Stop'

$patchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$currentRoot = (Get-Location).Path

function Test-BotRoot([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    return (Test-Path (Join-Path $path 'package.json')) -and (Test-Path (Join-Path $path 'src'))
}

$targetRoot = $null
if (Test-BotRoot $patchRoot) {
    $targetRoot = $patchRoot
} elseif (Test-BotRoot $currentRoot) {
    $targetRoot = $currentRoot
} else {
    $parent = Split-Path -Parent $patchRoot
    if (Test-BotRoot $parent) { $targetRoot = $parent }
}

if (-not $targetRoot) {
    Write-Host 'ERROR: bot project root was not found.' -ForegroundColor Red
    Write-Host 'Extract this archive into the bot project root and run APPLY_V172_VK_HISTORY_PROGRESS_FIX.cmd.' -ForegroundColor Yellow
    exit 2
}

$payloadApp = Join-Path $patchRoot 'payload\src\app\botApplication.js'
$targetApp = Join-Path $targetRoot 'src\app\botApplication.js'
if (-not (Test-Path $payloadApp)) {
    Write-Host 'ERROR: payload app file is missing.' -ForegroundColor Red
    exit 3
}

$expectedHash = 'F38974EEC95C2E5CCE64DB154D13FAFE9BEC96F94D3D4B6F47F1D1F3EF3036D4'
$actualHash = (Get-FileHash -Algorithm SHA256 $payloadApp).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) {
    Write-Host 'ERROR: patch checksum mismatch.' -ForegroundColor Red
    exit 4
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    & node --check $payloadApp
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: node syntax check failed. Nothing was changed.' -ForegroundColor Red
        exit 5
    }
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $targetRoot ('data\backups\pre-v172-source-' + $timestamp)
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
if (Test-Path $targetApp) {
    Copy-Item -Force $targetApp (Join-Path $backupDir 'botApplication.js')
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetApp) | Out-Null
Copy-Item -Force $payloadApp $targetApp

$installedHash = (Get-FileHash -Algorithm SHA256 $targetApp).Hash.ToUpperInvariant()
if ($installedHash -ne $expectedHash) {
    Write-Host 'ERROR: installed source checksum mismatch.' -ForegroundColor Red
    exit 6
}

Write-Host ''
Write-Host 'V172 VK history progress fix installed successfully.' -ForegroundColor Green
Write-Host ('Project: ' + $targetRoot)
Write-Host ('Source backup: ' + $backupDir)
Write-Host 'Database was NOT replaced or modified by this installer.'
Write-Host 'Start the bot normally with npm start.'
Write-Host 'Recovery now runs in background and logs progress every 10 pages.'
exit 0
