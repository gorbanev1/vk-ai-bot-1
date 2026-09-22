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
    if (Test-BotRoot $parent) {
        $targetRoot = $parent
    }
}

if (-not $targetRoot) {
    Write-Host 'ERROR: bot project root was not found.' -ForegroundColor Red
    Write-Host 'Extract this archive into the bot project root and run APPLY_V170_HISTORY_RECOVERY.cmd again.' -ForegroundColor Yellow
    exit 2
}

$payload = Join-Path $patchRoot 'payload'
$payloadDb = Join-Path $payload 'data\bot.sqlite'
$payloadApp = Join-Path $payload 'src\app\botApplication.js'

if (-not (Test-Path $payloadDb)) {
    Write-Host 'ERROR: payload\data\bot.sqlite is missing.' -ForegroundColor Red
    exit 3
}
if (-not (Test-Path $payloadApp)) {
    Write-Host 'ERROR: payload\src\app\botApplication.js is missing.' -ForegroundColor Red
    exit 4
}

$expectedHash = '63240C0956C1C17336D2A26FB2FB1644A1C62519C63299A9EA13C699F2DC73C8'
$actualHash = (Get-FileHash -Algorithm SHA256 $payloadDb).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) {
    Write-Host 'ERROR: recovery database checksum mismatch.' -ForegroundColor Red
    exit 5
}

$targetData = Join-Path $targetRoot 'data'
$targetDb = Join-Path $targetData 'bot.sqlite'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $targetData ('backups\pre-v170-' + $timestamp)

New-Item -ItemType Directory -Force -Path $targetData | Out-Null
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

foreach ($name in @('bot.sqlite','bot.sqlite-wal','bot.sqlite-shm')) {
    $source = Join-Path $targetData $name
    if (Test-Path $source) {
        Copy-Item -Force $source (Join-Path $backupDir $name)
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $targetRoot 'src\app') | Out-Null
Copy-Item -Force $payloadApp (Join-Path $targetRoot 'src\app\botApplication.js')
Copy-Item -Force $payloadDb $targetDb

foreach ($name in @('bot.sqlite-wal','bot.sqlite-shm')) {
    $stale = Join-Path $targetData $name
    if (Test-Path $stale) {
        Remove-Item -Force $stale
    }
}

$installedHash = (Get-FileHash -Algorithm SHA256 $targetDb).Hash.ToUpperInvariant()
if ($installedHash -ne $expectedHash) {
    Write-Host 'ERROR: installed database checksum mismatch.' -ForegroundColor Red
    exit 6
}

Write-Host ''
Write-Host 'V170 history recovery installed successfully.' -ForegroundColor Green
Write-Host ('Project: ' + $targetRoot)
Write-Host ('Previous database backup: ' + $backupDir)
Write-Host 'Start the bot normally with npm start.'
Write-Host 'The bot will automatically backfill missing VK chat history into peer 2000000006.'
exit 0
