@echo off
setlocal
cd /d "%~dp0"
echo.
echo =========================================
echo        OptiTrade Startup Check
echo =========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  echo Install Node.js 24.x 64-bit, then reopen this file.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if not "%NODE_MAJOR%"=="24" (
  echo ERROR: OptiTrade requires Node.js 24.x.
  echo Current version:
  node --version
  pause
  exit /b 1
)
echo Node:
node --version
echo.
if not exist ".env" (
  echo ERROR: .env is missing.
  echo Copy .env.example to .env and configure it first.
  pause
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  echo ERROR: node_modules is not ready.
  echo Run: npm install
  pause
  exit /b 1
)
if exist "database\optitrade.db" (
  echo Existing database found.
) else (
  echo No local database found. A new database will be created on first start.
)
echo Starting OptiTrade...
echo.
call npm start
pause
