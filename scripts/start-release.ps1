# Build the frontend and serve the release daemon on http://127.0.0.1:4178/
# Usage (from repo root or anywhere):
#   .\scripts\start-release.ps1
#   .\start-release.cmd

. (Join-Path $PSScriptRoot 'maia-start.ps1')

Set-Location $MaiaRoot
Stop-ListenersOnPort 4178

Write-MaiaInfo 'Building frontend/dist...'
& npm run build --prefix frontend
if ($LASTEXITCODE -ne 0) {
  throw "Frontend build failed with exit code $LASTEXITCODE."
}

Write-MaiaInfo 'Open http://127.0.0.1:4178/ after the daemon starts.'
& cargo run -p maia-daemon --release
exit $LASTEXITCODE
