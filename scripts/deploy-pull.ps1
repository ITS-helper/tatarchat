# TatarChat — удалённый деплой: git pull, сборка клиента, перезапуск только Node (порт 3001).
# Docker и Caddy не трогаются. Запускать на СЕРВЕРЕ под тем же пользователем, от которого рабочий git pull.
# Пример по SSH:  ssh user@100.x.x.x  powershell -ExecutionPolicy Bypass -File C:\tatarchat\scripts\deploy-pull.ps1

param(
    [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string] $Branch = 'main',
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'

Write-Host "=== TatarChat deploy-pull ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
Set-Location $RepoRoot

if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    throw "Не найден .git в $RepoRoot"
}

Write-Host "[1/3] git pull origin $Branch ..."
git pull origin $Branch
if ($LASTEXITCODE -ne 0) { throw "git pull завершился с кодом $LASTEXITCODE" }

if (-not $SkipBuild) {
    Write-Host "[2/3] npm run build (client) ..."
    Push-Location (Join-Path $RepoRoot 'client')
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build завершился с кодом $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[2/3] пропуск сборки (-SkipBuild)"
}

Write-Host "[3/3] перезапуск Node на порту 3001 ..."
$pids = @()
try {
    $pids = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
} catch {
    # старые системы без модуля
}
foreach ($procId in $pids) {
    if ($procId -gt 0) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Host "  остановлен PID $procId"
    }
}
if ($pids.Count -eq 0) {
    # запасной вариант как в stop.bat
    $lines = netstat -ano | Select-String ':3001\s.*LISTENING'
    foreach ($line in $lines) {
        $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
        $last = $parts[-1]
        if ($last -match '^\d+$') {
            Stop-Process -Id [int]$last -Force -ErrorAction SilentlyContinue
            Write-Host "  остановлен PID $last (netstat)"
        }
    }
}

Start-Sleep -Seconds 1
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$serverDir = Join-Path $RepoRoot 'server'
Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $serverDir -WindowStyle Hidden
Write-Host "  node server.js запущен в фоне."
Write-Host "=== Готово ===" -ForegroundColor Green
