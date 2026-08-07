@echo off
setlocal
cd /d "%~dp0" >nul 2>nul
if errorlevel 1 (
  echo [DeepSeek Balance Card] Failed to enter project directory: %~dp0
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [DeepSeek Balance Card] npm not found. Please install Node.js 18+ first.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [DeepSeek Balance Card] First run: installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [DeepSeek Balance Card] Dependency install failed. Check your network and try again.
    pause
    exit /b 1
  )
)

start "" /d "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" .
exit /b 0
