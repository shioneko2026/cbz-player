@echo off
REM ============================================================
REM  [000-Run CBZ Player Here].bat - CBZ Player v5 Folder Launcher
REM
REM  Copy this .bat into any folder containing CBZ files.
REM  Double-click it to launch CBZ Player and auto-load all
REM  CBZ files from THIS folder (surface level only).
REM
REM  Sort destination = this folder.
REM ============================================================

set "CBZ_PLAYER_FOLDER=%~dp0"
set "APP_DIR=H:\[02-AHW Data]\[Homebrew Programs]\CBZ Player"

cd /d "%APP_DIR%"
call npx tsc -p tsconfig.node.json 2>nul
npm run dev
