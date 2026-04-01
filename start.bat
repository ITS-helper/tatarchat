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
    echo   правой кнопкой -^> "Запуск от имени
    echo   администратора"
    echo ============================================
    pause
    exit /b 1
)

echo ============================================
echo   TatarChat — Запуск всех компонентов
echo ============================================
echo.

:: Каталог проекта = где лежит этот батник (D:\ C:\ — не важно)
cd /d "%~dp0"
if not exist "docker-compose.yml" (
    echo ОШИБКА: docker-compose.yml не найден в "%CD%"
    echo Убедись, что start.bat лежит в корне репозитория tatarchat.
    pause
    exit /b 1
)

:: 0. Docker daemon
echo [0/4] Проверка Docker...
docker info >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo ОШИБКА: демон Docker недоступен ^(docker info^).
    echo - Открой Docker Desktop и дождись статуса "Engine running" / зелёной иконки.
    echo - Если Docker только установили — перезагрузи ПК один раз.
    echo - Выполни в этом окне:  docker info
    echo   Если там ошибка — чини Docker, а не этот батник.
    pause
    exit /b 1
)
echo     Docker отвечает.

:: 1. Docker / PostgreSQL
echo [1/4] Запуск базы данных ^(docker compose^)...
docker compose up -d
if %errorLevel% neq 0 (
    echo     Пробую docker-compose ^(старый синтаксис^)...
    docker-compose up -d
)
if %errorLevel% neq 0 (
    echo.
    echo ОШИБКА: не удалось выполнить docker compose up -d
    echo Каталог: %CD%
    echo Запусти вручную и смотри текст ошибки:
    echo   docker compose up -d
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

:: 3. Caddy ^(C:\caddy или D:\caddy^)
echo [3/4] Запуск Caddy...
set "CADDY_DIR="
if exist "C:\caddy\caddy.exe" set "CADDY_DIR=C:\caddy"
if not defined CADDY_DIR if exist "D:\caddy\caddy.exe" set "CADDY_DIR=D:\caddy"
if not defined CADDY_DIR (
    echo ОШИБКА: caddy.exe не найден ни в C:\caddy, ни в D:\caddy
    echo Положи caddy.exe и Caddyfile в C:\caddy ^(или поправь этот батник^).
    pause
    exit /b 1
)
taskkill /IM caddy.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
start "Caddy" /min cmd /c "cd /d %CADDY_DIR% && caddy.exe run 2>&1"
timeout /t 2 /nobreak >nul
echo     Caddy запущен из %CADDY_DIR%
echo.

:: 4. Node.js
echo [4/4] Запуск сервера...
echo.
echo ============================================
echo   Готово! Сайт: https://dtdfamily.ru
echo   Не закрывай это окно!
echo ============================================
echo.

cd /d "%~dp0server"
node server.js

echo.
echo === Сервер остановился ===
pause
