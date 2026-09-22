@echo off
setlocal
cd /d "%~dp0"

set "BASE=%~dp0"
set "TARGET=%BASE%src"
set "OUT=%BASE%SRC_TREE_DUMP.txt"

rem If script was placed directly inside src, use current folder.
if not exist "%TARGET%\" (
    for %%I in ("%BASE:~0,-1%") do set "LAST=%%~nxI"
    if /I "%LAST%"=="src" (
        set "TARGET=%BASE:~0,-1%"
        set "OUT=%BASE%SRC_TREE_DUMP.txt"
    )
)

if not exist "%TARGET%\" (
    echo ERROR: src folder not found.
    echo Put this file either in the project root next to src,
    echo or directly inside the src folder.
    echo.
    pause
    exit /b 1
)

> "%OUT%" echo SRC DIRECTORY DUMP
>>"%OUT%" echo Generated: %date% %time%
>>"%OUT%" echo Target: %TARGET%
>>"%OUT%" echo.

>>"%OUT%" echo ============================================================
>>"%OUT%" echo TREE
>>"%OUT%" echo ============================================================
tree "%TARGET%" /F /A >> "%OUT%" 2>&1

>>"%OUT%" echo.
>>"%OUT%" echo ============================================================
>>"%OUT%" echo FULL RECURSIVE LIST WITH SIZE AND DATE
>>"%OUT%" echo ============================================================
dir /s /a /-c "%TARGET%" >> "%OUT%" 2>&1

>>"%OUT%" echo.
>>"%OUT%" echo ============================================================
>>"%OUT%" echo FILE EXTENSION SUMMARY
>>"%OUT%" echo ============================================================

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$target=[IO.Path]::GetFullPath('%TARGET%');" ^
  "$out=[IO.Path]::GetFullPath('%OUT%');" ^
  "Get-ChildItem -LiteralPath $target -File -Recurse -Force -ErrorAction SilentlyContinue |" ^
  "Group-Object Extension | Sort-Object Count -Descending |" ^
  "ForEach-Object { '{0,6}  {1}' -f $_.Count, ($(if([string]::IsNullOrWhiteSpace($_.Name)){'[no extension]'}else{$_.Name})) } |" ^
  "Add-Content -LiteralPath $out -Encoding UTF8"

>>"%OUT%" echo.
>>"%OUT%" echo ============================================================
>>"%OUT%" echo LARGEST 100 FILES
>>"%OUT%" echo ============================================================

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$target=[IO.Path]::GetFullPath('%TARGET%').TrimEnd('\');" ^
  "$out=[IO.Path]::GetFullPath('%OUT%');" ^
  "Get-ChildItem -LiteralPath $target -File -Recurse -Force -ErrorAction SilentlyContinue |" ^
  "Sort-Object Length -Descending | Select-Object -First 100 |" ^
  "ForEach-Object {" ^
  "  $rel=$_.FullName.Substring($target.Length).TrimStart('\');" ^
  "  '{0,14} bytes  {1}' -f $_.Length,$rel" ^
  "} | Add-Content -LiteralPath $out -Encoding UTF8"

echo.
echo DONE
echo Created:
echo %OUT%
echo.
echo Send SRC_TREE_DUMP.txt to ChatGPT.
echo.
pause
