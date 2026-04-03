# TatarChat remote deploy: git pull, client build (npm run build in client -> dist), restart Node on port 3001.
# Docker and Caddy are left running. Run as the same Windows user that can git pull.
# Example: ssh user@100.x.x.x powershell -ExecutionPolicy Bypass -File C:\tatarchat\scripts\deploy-pull.ps1
# Full stack (includes same client rebuild + scheduled stop.bat/start.bat):
#   ssh Tatarfamily@100.123.209.16 powershell -ExecutionPolicy Bypass -File C:\tatarchat\scripts\deploy-pull.ps1 -FullRestart
# Optional: after start.bat also start Automatic1111 (minimized), if path is set:
#   $env:TATARCHAT_SD_WEBUI_BAT = 'D:\sd\stable-diffusion-webui\webui-user.bat'
#   или  -SdWebuiBat 'D:\sd\stable-diffusion-webui\webui-user.bat'

param(
    [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string] $Branch = 'main',
    [switch] $SkipBuild,
    [switch] $FullRestart,
    [string] $SdWebuiBat = $env:TATARCHAT_SD_WEBUI_BAT
)

$ErrorActionPreference = 'Stop'

Write-Host "=== TatarChat deploy-pull ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
Set-Location $RepoRoot

if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    throw ".git not found: $RepoRoot"
}

$logFile = Join-Path $RepoRoot 'scripts\last-deploy.log'
function Append-DeployLog([string]$msg) {
    Add-Content -LiteralPath $logFile -Value $msg -Encoding ascii
}

try {
    Append-DeployLog '----'
    Append-DeployLog ('START ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))

    Write-Host "[1/3] git pull origin $Branch ..."
    git pull origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git pull failed exit=$LASTEXITCODE" }

    if (-not $SkipBuild) {
        Write-Host "[2/3] client: npm run build (Vite -> client\dist for Caddy) ..."
        Push-Location (Join-Path $RepoRoot 'client')
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed exit=$LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        Write-Host "  client dist ready: $(Join-Path $RepoRoot 'client\dist')" -ForegroundColor DarkGray
    } else {
        Write-Host "[2/3] skip client build (-SkipBuild)"
    }

    Write-Host "[3/3] restart Node on port 3001 ..."
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        # older systems
    }
    foreach ($procId in $pids) {
        if ($procId -gt 0) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Write-Host "  stopped PID $procId"
        }
    }
    if ($pids.Count -eq 0) {
        $lines = netstat -ano | Select-String ':3001\s.*LISTENING'
        foreach ($line in $lines) {
            $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
            $last = $parts[-1]
            if ($last -match '^\d+$') {
                Stop-Process -Id [int]$last -Force -ErrorAction SilentlyContinue
                Write-Host "  stopped PID $last (netstat)"
            }
        }
    }

    Start-Sleep -Seconds 1
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $serverDir = Join-Path $RepoRoot 'server'
    # Win32_Process.Create avoids OpenSSH killing the child when the session ends.
    $cmdLine = '"' + $nodeExe + '" server.js'
    $cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = $cmdLine
        CurrentDirectory = $serverDir
    }
    if ($cim.ReturnValue -ne 0) {
        throw "Win32_Process.Create failed ReturnValue=$($cim.ReturnValue)"
    }
    Write-Host "  node server.js started (PID $($cim.ProcessId))."

    $rev = 'unknown'
    $g = git -C $RepoRoot rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $g) {
        $rev = ($g | Select-Object -First 1).ToString().Trim()
    }
    Append-DeployLog ('OK git=' + $rev)
    Append-DeployLog 'DONE'
    Write-Host "=== Done ===" -ForegroundColor Green
    Write-Host "Log: $logFile" -ForegroundColor DarkGray

    if ($FullRestart) {
        Write-Host "=== Full restart requested (stop.bat + start.bat as admin) ===" -ForegroundColor Yellow
        $taskName = "TatarChat-FullRestart"
        $repoRootWin = $RepoRoot
        $stopBat = Join-Path $repoRootWin "stop.bat"
        $startBat = Join-Path $repoRootWin "start.bat"
        if (-not (Test-Path $stopBat) -or -not (Test-Path $startBat)) {
            throw "stop.bat or start.bat not found in $RepoRoot"
        }

        $sdPart = ''
        if ($SdWebuiBat) {
            if (Test-Path -LiteralPath $SdWebuiBat) {
                # start "" /MIN — отдельное окно, свёрнутое; WebUI с --api продолжит работать после выхода из цепочки cmd
                $sdPart = " && timeout /t 3 /nobreak >nul && start `"`" /MIN `"$SdWebuiBat`""
                Write-Host "  SD WebUI after start: $SdWebuiBat" -ForegroundColor DarkGray
            } else {
                Write-Warning "SdWebuiBat not found (SD autostart skipped): $SdWebuiBat"
            }
        }

        # Пересоздаём задачу каждый раз — чтобы подтянуть актуальный путь к webui-user.bat при смене env.
        $exists = $false
        try {
            schtasks /Query /TN $taskName *> $null
            if ($LASTEXITCODE -eq 0) { $exists = $true }
        } catch {}

        $cmd = "cmd.exe /c `"set TC_NO_PAUSE=1 && `"$stopBat`" && timeout /t 2 /nobreak >nul && `"$startBat`"$sdPart`""
        schtasks /Create /F /TN $taskName /SC ONDEMAND /RL HIGHEST /RU SYSTEM /TR $cmd | Out-Null
        if ($exists) {
            Write-Host "  Updated scheduled task: $taskName"
        } else {
            Write-Host "  Created scheduled task: $taskName"
        }

        schtasks /Run /TN $taskName | Out-Null
        Write-Host "  Triggered scheduled task: $taskName"
        $logSd = if ($sdPart) { " SD=$SdWebuiBat" } else { '' }
        Append-DeployLog "FULL_RESTART task=$taskName$logSd"
    }
} catch {
    Append-DeployLog 'FAIL'
    throw
}
