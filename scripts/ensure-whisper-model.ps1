# Downloads the bundled English Whisper model if missing (used before dev/release builds).
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$destDir = Join-Path $root "src-tauri\resources\models"
$dest = Join-Path $destDir "ggml-base.en.bin"
$url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

if (Test-Path $dest) {
  $sizeMb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
  Write-Host "Whisper model ready: $dest ($sizeMb megabytes)"
  exit 0
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Write-Host "Downloading ggml-base.en.bin (~148 megabytes) for the installer..."
Invoke-WebRequest -Uri $url -OutFile $dest
$sizeMb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "Done: $dest ($sizeMb megabytes)"
