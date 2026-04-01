$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $root

$gradlePath = Join-Path $root "android/app/build.gradle"
$apkSrc = Join-Path $root "android/app/build/outputs/apk/debug/app-debug.apk"
$outDir = "D:\tatarchat\apk"

if (!(Test-Path $gradlePath)) { throw "build.gradle not found: $gradlePath" }
if (!(Test-Path $apkSrc)) { throw "APK not found: $apkSrc. Build it first." }

$txt = Get-Content -Raw -Encoding UTF8 $gradlePath

function Extract-GradleValue($text, $key) {
  $lines = $text -split "`r?`n"
  foreach ($l in $lines) {
    $s = $l.Trim()
    if ($s -like "$key *") {
      # versionCode 1
      if ($key -eq "versionCode") {
        $parts = $s -split "\s+"
        if ($parts.Length -ge 2) { return $parts[1].Trim() }
      }
      # versionName "1.0"
      if ($key -eq "versionName") {
        $i = $s.IndexOf('"')
        if ($i -ge 0) {
          $j = $s.IndexOf('"', $i + 1)
          if ($j -gt $i) { return $s.Substring($i + 1, $j - $i - 1) }
        }
      }
    }
  }
  return $null
}

$verName = Extract-GradleValue $txt "versionName"
$verCode = Extract-GradleValue $txt "versionCode"
if (-not $verName) { $verName = "unknown" }
if (-not $verCode) { $verCode = "0" }

$ts = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$fileName = "TatarChat-debug-v$verName($verCode)-$ts.apk"

if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$dst = Join-Path $outDir $fileName

Copy-Item -Force $apkSrc $dst
Write-Output $dst

