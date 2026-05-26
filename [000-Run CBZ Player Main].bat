@echo off
cd /d "%~dp0"
call npx tsc -p tsconfig.node.json
start "" npm run dev
