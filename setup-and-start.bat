@echo off
REM One-click Windows launcher: installs deps, installs Ollama + Gemma if missing, builds, starts.
cd /d "%~dp0"
if not exist node_modules (
  call npm install || goto :fail
)
call npm run setup:gemma || goto :fail
call npm run build || goto :fail
start "" cmd /c "timeout /t 5 >nul & start http://localhost:3000"
call npm start
goto :eof
:fail
echo.
echo Setup failed - see the messages above.
pause
