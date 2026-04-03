# TatarChat: backup PostgreSQL (Docker) + uploads folder.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File "C:\tatarchat\scripts\backup-tatarchat.ps1"

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
if (-not (Test-Path (Join-Path $Root "docker-compose.yml"))) {
    Write-Error "docker-compose.yml not found near $Root"
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$OutDir = Join-Path $Root "backups\$Stamp"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$Container = "tatarchat-db"
$DbName = "tatarchat-db"
$DumpInContainer = "/tmp/tatarchat-backup.dump"

Write-Host "Project root: $Root"
Write-Host "Backup dir:   $OutDir"

$running = docker ps -q -f "name=$Container"
if (-not $running) {
    Write-Error "Container $Container is not running. Run: docker compose up -d"
}

Write-Host "pg_dump (custom format)..."
docker exec $Container pg_dump -U postgres -d $DbName -Fc -f $DumpInContainer
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump failed" }

$DumpLocal = Join-Path $OutDir "tatarchat-db.dump"
docker cp "${Container}:${DumpInContainer}" $DumpLocal
if ($LASTEXITCODE -ne 0) { Write-Error "docker cp failed" }

Write-Host "pg_dump (plain SQL fallback)..."
$SqlLocal = Join-Path $OutDir "tatarchat-db-plain.sql"
docker exec $Container pg_dump -U postgres -d $DbName -Fp --no-owner --no-acl | Set-Content -Path $SqlLocal -Encoding UTF8

$Uploads = Join-Path $Root "server\data\uploads"
if (Test-Path $Uploads) {
    Write-Host "Copying uploads..."
    $UploadsDest = Join-Path $OutDir "uploads"
    Copy-Item -Path $Uploads -Destination $UploadsDest -Recurse -Force
} else {
    Write-Host "No uploads folder (ok if empty chat): $Uploads"
}

$EnvSrc = Join-Path $Root "server\.env"
if (Test-Path $EnvSrc) {
    Copy-Item $EnvSrc (Join-Path $OutDir "dot-env.example-copy.txt")
    Write-Host "Copied server\.env as dot-env.example-copy.txt - on new PC rename to .env and fix DATABASE_URL."
}

$Instr = Join-Path $ScriptDir "README-BACKUP-RESTORE-RU.txt"
if (Test-Path $Instr) {
    Copy-Item $Instr (Join-Path $OutDir "README-RESTORE-RU.txt")
}

Write-Host ""
Write-Host "Done. Files:"
Get-ChildItem $OutDir -Recurse | Select-Object FullName
