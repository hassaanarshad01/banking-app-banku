@echo off
setlocal
start "Banku Backend" /D "%~dp0" cmd /k npm run dev
start "Banku Frontend" /D "%~dp0frontend" cmd /k npm run dev
endlocal
