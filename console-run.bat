@echo off
cd /d "%~dp0"

rem ============================================================
rem  flint-console quick launcher (flint-run.bat's sibling)
rem  - checks node and flint repo
rem  - starts server, opens browser after 3s
rem  - stop: press Ctrl+C in this window (graceful shutdown)
rem  Set CONSOLE_NO_BROWSER=1 to skip auto browser open.
rem ============================================================

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found in PATH. Install Node.js first.
    pause
    exit /b 1
)

rem Node >= 22.18 required: native TypeScript execution (type stripping)
node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<18)){console.error('[ERROR] Node '+process.versions.node+' too old. Need >= 22.18 (native TypeScript).');process.exit(1)}"
if errorlevel 1 (
    pause
    exit /b 1
)

rem flint repo must sit next to this folder (or set FLINT_ROOT)
if not exist "%~dp0..\Flint\src\index.ts" (
    if "%FLINT_ROOT%"=="" (
        echo [ERROR] flint repo not found at ..\Flint
        echo Fix: place flint-console next to the Flint folder, or set FLINT_ROOT.
        pause
        exit /b 1
    )
)

set PORT_NUM=3210
if not "%PORT%"=="" set PORT_NUM=%PORT%

echo Starting flint-console: http://localhost:%PORT_NUM%  (Ctrl+C to stop)
if "%CONSOLE_NO_BROWSER%"=="" (
    start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT_NUM%"
)
node server\main.ts

pause
