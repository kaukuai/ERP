@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "app\scripts\local.mjs" --backup %*
) else (
  node "scripts\local.mjs" --backup %*
)
pause
