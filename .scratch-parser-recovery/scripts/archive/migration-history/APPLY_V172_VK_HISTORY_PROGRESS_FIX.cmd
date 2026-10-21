@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0APPLY_V172_VK_HISTORY_PROGRESS_FIX.ps1"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo V172 installation failed with exit code %RC%.
  pause
  exit /b %RC%
)
echo.
echo V172 installation completed successfully.
pause
exit /b 0
