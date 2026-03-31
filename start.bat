@echo off
chcp 65001 >nul
title TatarChat — Запуск

:: Проверка прав администратора
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ============================================
    echo   ОШИБКА: нужны права администратора!
    echo.
    echo   Закрой это окно и запусти start.bat
    echo   правой кнопкой -> "Запуск от имени
    echo   администратора"
    echo ============================================
    pause
    exit /b 1
)

echo ============================================
echo   TatarChat — Запуск всех компонентов
echo ============================================
echo.

cd /d "d:\tatarchat"

:: 1. Docker / PostgreSQL
echo [1/4] Запуск базы данных (Docker)...
docker compose up -d
if %errorLevel% neq 0 (
    echo.
    echo ОШИБКА: Docker не запущен!
    echo Запусти Docker Desktop и повтори.
    pause
    exit /b 1
)

echo     Ожидание PostgreSQL...
:waitdb
docker exec tatarchat-db pg_isready -U postgres -d tatarchat-db >nul 2>&1
if %errorLevel% neq 0 (
    timeout /t 2 /nobreak >nul
    goto waitdb
)
echo     PostgreSQL готов!
echo.

:: 2. Освобождаем порт 3001
echo [2/4] Проверка порта 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001 " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo     Готово.
echo.

:: 3. Caddy
echo [3/4] Запуск Caddy...
if not exist "D:\caddy\caddy.exe" (
    echo ОШИБКА: D:\caddy\caddy.exe не найден!
    pause
    exit /b 1
)
taskkill /IM caddy.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
start "Caddy" /min cmd /c "cd /d D:\caddy && caddy.exe run 2>&1"
timeout /t 2 /nobreak >nul
echo     Caddy запущен.
echo.

:: 4. Node.js
echo [4/4] Запуск сервера...
echo.
echo ============================================
echo   Готово! Сайт: https://dtdfamily.ru
echo   Не закрывай это окно!
echo ============================================
echo.

cd /d "d:\tatarchat\server"
node server.js

echo.
echo === Сервер остановился ===
pause
