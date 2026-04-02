@echo off
chcp 65001 >nul
title TatarChat — Остановка

echo Остановка TatarChat...

:: Убиваем Node.js на порту 3001
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001 " ^| findstr "LISTENING" 2^>nul') do (
    echo Останавливаю сервер (PID %%a)...
    taskkill /PID %%a /F >nul 2>&1
)

:: Останавливаем Caddy
taskkill /IM caddy.exe /F >nul 2>&1
echo Caddy остановлен.
:: (Caddy лежит в D:\caddy)

:: Останавливаем Docker
cd /d "%~dp0"
docker compose down
echo Docker остановлен.

echo.
echo Всё остановлено.
if "%TC_NO_PAUSE%"=="1" exit /b 0
pause
