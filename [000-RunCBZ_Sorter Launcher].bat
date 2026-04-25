@echo off
cd /d "%~dp0"

start "" powershell -ExecutionPolicy Bypass -File "[001-CBZ_Sorter].ps1"
start "" "[002-CBZSorterGlobalHotKeys].ahk"
