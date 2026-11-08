# Shared helpers for Maia start scripts. Dot-source from the sibling scripts.
$ErrorActionPreference = 'Stop'

$MaiaRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Write-MaiaInfo([string]$Message) {
  Write-Host $Message
}

function Stop-ListenersOnPort([int]$Port) {
  $owners = @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  foreach ($owner in $owners) {
    if ($null -eq $owner -or $owner -eq 0) { continue }
    $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    Write-MaiaInfo "Stopping $($process.ProcessName) (pid $owner) on port $Port."
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  }
}

function Wait-LocalPort([int]$Port, [int]$TimeoutSec = 120) {
  $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)
  while ([datetime]::UtcNow -lt $deadline) {
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $client.Connect('127.0.0.1', $Port)
      $client.Close()
      return
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  throw "Timed out waiting for 127.0.0.1:$Port."
}

function Start-MaiaDaemonProcess([switch]$Release, [switch]$Watch) {
  if ($Watch) {
    if (-not (Get-Command cargo-watch -ErrorAction SilentlyContinue)) {
      throw "cargo-watch is not installed. Install with: cargo install cargo-watch"
    }
    $run = if ($Release) { 'run -p maia-daemon --release' } else { 'run -p maia-daemon' }
    $argumentList = @('watch', '-q', '-w', 'crates', '-x', $run)
  } elseif ($Release) {
    $argumentList = @('run', '-p', 'maia-daemon', '--release')
  } else {
    $argumentList = @('run', '-p', 'maia-daemon')
  }

  Write-MaiaInfo "Starting daemon: cargo $($argumentList -join ' ')"
  return Start-Process `
    -FilePath 'cargo' `
    -ArgumentList $argumentList `
    -WorkingDirectory $MaiaRoot `
    -PassThru `
    -NoNewWindow
}

function Stop-MaiaProcessTree([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process) { return }
  if ($Process.HasExited) { return }
  Write-MaiaInfo "Stopping process tree for pid $($Process.Id)."
  & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
}
