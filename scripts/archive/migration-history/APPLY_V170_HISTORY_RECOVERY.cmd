@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0APPLY_V170_HISTORY_RECOVERY.ps1"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo V170 installation failed with exit code %RC%.
  pause
  exit /b %RC%
)
echo.
echo V170 installation completed successfully.
pause
exit /b 0
