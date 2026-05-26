@echo off
title CBZ Player - Build Installer
cd /d "%~dp0"

echo.
echo === Building CBZ Player Installer ===
echo.
echo Project: %CD%
echo.
echo Step 1 of 2: vite build (renderer) + tsc build (main)
echo Step 2 of 2: electron-builder NSIS (downloads ~150 MB on first run, then caches)
echo.
echo First run typically takes 5-15 minutes. Subsequent builds: ~30-60 seconds.
echo.

call npm run pack
set EXIT_CODE=%errorlevel%

echo.
if %EXIT_CODE% neq 0 (
  echo === BUILD FAILED (exit code %EXIT_CODE%^) ===
  echo Scroll up to see the error. Common causes:
  echo   - Windows Developer Mode is off ^(symlink error in winCodeSign extraction^)
  echo   - npm install was never run ^(missing node_modules^)
  echo   - A renderer or main TypeScript error
) else (
  echo === BUILD SUCCEEDED ===
  echo.
  echo Output file^(s^) in release\:
  dir /b "release\*.exe" 2>nul
  echo.
  echo Double-click the .exe above to install.
  echo.
  echo Opening the release folder in Explorer...
  start "" "%~dp0release"
)

echo.
pause
