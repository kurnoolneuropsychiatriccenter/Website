@echo off
REM =====================================================================
REM  Kurnool Neuro Psychiatric and ENT Center - Clinic Software Launcher
REM  Just double-click this file to start the clinic software.
REM =====================================================================

title Clinic Software - Kurnool Neuro Psychiatric and ENT Center

cd /d "%~dp0"

echo.
echo ========================================================
echo   Kurnool Neuro Psychiatric and ENT Center
echo   Clinic Software Launcher
echo ========================================================
echo.

REM ---------- Check Node.js is installed ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed on this computer.
    echo.
    echo   1. Please install Node.js LTS v20 from https://nodejs.org
    echo      Choose the "LTS" version, NOT the latest one.
    echo   2. Restart your computer.
    echo   3. Double-click start.bat again.
    echo.
    pause
    exit /b 1
)

echo Node.js version:
node -v
echo.

REM ---------- Install packages the first time ----------
if not exist "node_modules" (
    echo First time setup: installing required packages...
    echo This may take 2 to 5 minutes. Please wait.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        echo.
        echo   If you are on Node.js v24, v25 or v26 this can happen because
        echo   'sqlite3' has no prebuilt binary for that version yet.
        echo.
        echo   FIX: install Node.js LTS v20 from https://nodejs.org
        echo        Uninstall the current Node first, then install v20 LTS,
        echo        then double-click start.bat again.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Packages installed successfully.
    echo.
)

REM ---------- Start the server ----------
echo Starting Clinic Software on http://localhost:3000 ...
echo.
echo   *** DO NOT close this window while using the software. ***
echo   *** To stop the software, close this window. ***
echo.
echo Opening the software in your default browser in 3 seconds...
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"

node server.js

REM If server exits, keep the window open so user can read any error
echo.
echo Server has stopped.
pause
