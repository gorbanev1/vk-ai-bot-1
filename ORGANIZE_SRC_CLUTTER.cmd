@echo off
setlocal
cd /d "%~dp0"

set "BASE=%~dp0"
set "ROOT=%BASE%"
set "SRC=%ROOT%src"

rem If this script is placed inside src, infer project root one level up.
if not exist "%SRC%\" (
    for %%I in ("%BASE:~0,-1%") do set "LAST=%%~nxI"
    if /I "%LAST%"=="src" (
        set "SRC=%BASE:~0,-1%"
        for %%I in ("%BASE%..") do set "ROOT=%%~fI\"
    )
)

if not exist "%SRC%\" (
    echo ERROR: src folder not found.
    echo Put this file in project root or directly inside src.
    pause
    exit /b 1
)

set "PS1=%TEMP%\organize_src_%RANDOM%_%RANDOM%.ps1"

> "%PS1%" echo $ErrorActionPreference = "Stop"
>>"%PS1%" echo $Root = [IO.Path]::GetFullPath("%ROOT%").TrimEnd('\')
>>"%PS1%" echo $Src  = [IO.Path]::GetFullPath("%SRC%").TrimEnd('\')
>>"%PS1%" echo $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
>>"%PS1%" echo $Report = Join-Path $Root ("SRC_ORGANIZE_REPORT_" + $Stamp + ".txt")
>>"%PS1%" echo function EnsureDir([string]$p){ if(-not(Test-Path -LiteralPath $p)){ New-Item -ItemType Directory -Path $p -Force ^| Out-Null } }
>>"%PS1%" echo function SameFile([string]$a,[string]$b){ if(!(Test-Path -LiteralPath $a)-or !(Test-Path -LiteralPath $b)){return $false}; $ia=Get-Item -LiteralPath $a; $ib=Get-Item -LiteralPath $b; if($ia.PSIsContainer -or $ib.PSIsContainer){return $false}; if($ia.Length -ne $ib.Length){return $false}; return ((Get-FileHash -Algorithm SHA256 -LiteralPath $a).Hash -eq (Get-FileHash -Algorithm SHA256 -LiteralPath $b).Hash) }
>>"%PS1%" echo function Log([string]$s){ Write-Host $s; Add-Content -LiteralPath $Report -Value $s -Encoding UTF8 }
>>"%PS1%" echo function MoveSafe([string]$source,[string]$dest,[string]$conflictRel){
>>"%PS1%" echo   if(-not(Test-Path -LiteralPath $source)){ return }
>>"%PS1%" echo   EnsureDir (Split-Path -Parent $dest)
>>"%PS1%" echo   if(-not(Test-Path -LiteralPath $dest)){ Move-Item -LiteralPath $source -Destination $dest; Log ("[MOVE] " + $source + " -^> " + $dest); return }
>>"%PS1%" echo   if(SameFile $source $dest){ Remove-Item -LiteralPath $source -Force; Log ("[REMOVE IDENTICAL DUPLICATE] " + $source); return }
>>"%PS1%" echo   $confRoot=Join-Path $Root ("backup\src-organize-conflicts\"+$Stamp)
>>"%PS1%" echo   $conf=Join-Path $confRoot $conflictRel
>>"%PS1%" echo   EnsureDir (Split-Path -Parent $conf)
>>"%PS1%" echo   if(Test-Path -LiteralPath $conf){ $conf=$conf+"."+[Guid]::NewGuid().ToString("N").Substring(0,8) }
>>"%PS1%" echo   Move-Item -LiteralPath $source -Destination $conf
>>"%PS1%" echo   Log ("[CONFLICT PRESERVED] " + $source + " -^> " + $conf)
>>"%PS1%" echo }
>>"%PS1%" echo Set-Content -LiteralPath $Report -Value ("SRC ORGANIZE " + (Get-Date).ToString("o")) -Encoding UTF8
>>"%PS1%" echo Log ("ROOT: " + $Root)
>>"%PS1%" echo Log ("SRC:  " + $Src)
>>"%PS1%" echo Log ""
>>"%PS1%" echo MoveSafe (Join-Path $Src "INSTALL_V129.txt") (Join-Path $Root "docs\archive\src-history\V129\INSTALL_V129.txt") "INSTALL_V129.txt"
>>"%PS1%" echo MoveSafe (Join-Path $Src "PATCH_NOTES_EVENTS_V129_PINBALL_POP_BUMPER_POWER.txt") (Join-Path $Root "docs\archive\src-history\V129\PATCH_NOTES_EVENTS_V129_PINBALL_POP_BUMPER_POWER.txt") "PATCH_NOTES_EVENTS_V129_PINBALL_POP_BUMPER_POWER.txt"
>>"%PS1%" echo MoveSafe (Join-Path $Src "DEVELOPER_HANDOFF.md") (Join-Path $Root "docs\src\DEVELOPER_HANDOFF.md") "DEVELOPER_HANDOFF.md"
>>"%PS1%" echo MoveSafe (Join-Path $Src "app\botApplication.js.bak") (Join-Path $Root "backup\src-code-backups\app\botApplication.js.bak") "app\botApplication.js.bak"
>>"%PS1%" echo MoveSafe (Join-Path $Src "features\ai\providerDiagnostics.js.bak") (Join-Path $Root "backup\src-code-backups\features\ai\providerDiagnostics.js.bak") "features\ai\providerDiagnostics.js.bak"
>>"%PS1%" echo Log ""
>>"%PS1%" echo Log "[KEEP] src\README.md"
>>"%PS1%" echo Log "[KEEP] src\package.json"
>>"%PS1%" echo Log "[KEEP] all .js/.mjs/.html code"
>>"%PS1%" echo Log "[KEEP FOR SEPARATE AUDIT] src\src\app\botApplication.js"
>>"%PS1%" echo Log "[KEEP FOR SEPARATE AUDIT] src\tests"
>>"%PS1%" echo Log "[KEEP FOR SEPARATE AUDIT] src\miniapps"
>>"%PS1%" echo Log ""
>>"%PS1%" echo Log ("REPORT: " + $Report)

echo.
echo Organizing obvious src clutter...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"
del /q "%PS1%" >nul 2>&1

echo.
if not "%RC%"=="0" (
  echo FAILED with code %RC%
  pause
  exit /b %RC%
)

echo DONE.
echo A SRC_ORGANIZE_REPORT_*.txt file was created in project root.
echo.
pause
exit /b 0
