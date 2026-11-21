# Starts the release daemon at Windows logon (Scheduled Task "Maia Daemon").
# Does nothing when Maia is already listening on 4178. No build.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
& (Join-Path $root 'target\release\maia-daemon.exe')
exit $LASTEXITCODE
