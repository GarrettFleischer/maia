# Hot-reload frontend (Vite) against a live daemon API.
# - Daemon API + websocket: http://127.0.0.1:4178
# - App with HMR:           http://127.0.0.1:5173
#
# Usage:
#   .\scripts\start-dev.ps1
#   .\scripts\start-dev.ps1 -WatchDaemon   # also rebuild daemon on crate changes (needs cargo-watch)
#   .\start-dev.cmd

param(
  [switch]$WatchDaemon
)

. (Join-Path $PSScriptRoot 'maia-start.ps1')

Set-Location $MaiaRoot
Stop-ListenersOnPort 4178
Stop-ListenersOnPort 5173

$daemon = Start-MaiaDaemonProcess -Watch:$WatchDaemon
try {
  Write-MaiaInfo 'Waiting for daemon on 127.0.0.1:4178...'
  Wait-LocalPort 4178
  Write-MaiaInfo 'Daemon is up. Starting Vite with /api proxy.'
  Write-MaiaInfo 'Open http://127.0.0.1:5173/ (not :4178) for hot reload.'
  Push-Location (Join-Path $MaiaRoot 'frontend')
  try {
    & npm run dev
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  Stop-MaiaProcessTree $daemon
  Stop-ListenersOnPort 4178
}
