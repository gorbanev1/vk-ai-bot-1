@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0APPLY_V171_VK_HISTORY_FIX.ps1"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo V171 installation failed with exit code %RC%.
  pause
  exit /b %RC%
)
echo.
echo V171 installation completed successfully.
pause
exit /b 0
