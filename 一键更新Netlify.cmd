@echo off
setlocal
cd /d "%~dp0"
title Alpine Flow Lab - Netlify One-Click Deploy

echo ========================================
echo   Alpine Flow Lab - Netlify Deploy
echo ========================================
echo.

where npm >nul 2>nul
if errorlevel 1 goto missing_node

if not exist ".netlify\state.json" goto missing_site

if /i "%~1"=="--check" (
  echo One-click deploy prerequisite check passed.
  exit /b 0
)

echo Building the local project and deploying to Netlify production...
echo.
call npm run deploy:netlify
if errorlevel 1 goto failed

echo.
echo ========================================
echo Deploy succeeded: https://alpine-flow-lab-wce57.netlify.app
echo ========================================
echo.
pause
exit /b 0

:missing_node
echo npm was not found. Install the Node.js version required by this project.
goto failed_pause

:missing_site
echo This project is not linked to Netlify: .netlify\state.json is missing.
goto failed_pause

:failed
echo.
echo Netlify deploy failed. Review the error output above.

:failed_pause
echo.
pause
exit /b 1
