@echo off
REM ============================================================
REM  Run_Here.bat - CBZ Sorter v5 Shortcut Launcher
REM
REM  Copy this .bat into any folder containing CBZ files.
REM  Double-click it to launch CBZ Sorter and auto-load all
REM  CBZ files from THIS folder (surface level only).
REM
REM  Sort destination = this folder.
REM ============================================================

set "CBZ_SORTER_FOLDER=%~dp0"
set "APP_DIR=H:\[02-AHW Data]\[Homebrew Programs]\CBZ Sorter Folder\CBZ Sorter NEW"

cd /d "%APP_DIR%"
call npx tsc -p tsconfig.node.json 2>nul
npm run dev
