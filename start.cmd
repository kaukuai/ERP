@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "app\scripts\local.mjs" %*
) else (
  node "scripts\local.mjs" %*
)
pause
