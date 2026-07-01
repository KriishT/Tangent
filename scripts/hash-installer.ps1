# Print SHA-256 for release installers (run after npm run tauri:build:voice)
$root = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle"
$files = @(
  (Join-Path $root "nsis\Tangent_*_x64-setup.exe"),
  (Join-Path $root "dmg\Tangent_*.dmg")
)
foreach ($pattern in $files) {
  Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | ForEach-Object {
    $hash = Get-FileHash $_.FullName -Algorithm SHA256
    Write-Output ""
    Write-Output "$($_.Name)"
    Write-Output "  SHA-256: $($hash.Hash)"
    Write-Output "  Path:    $($_.FullName)"
  }
}
