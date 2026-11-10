# Stop TailMic on this PC (receiver window + server). Works from the desktop and over SSH.
# Tailscale Serve stays configured.
. (Join-Path $PSScriptRoot 'common.ps1')
$before = @(Get-TailMicProcesses)
if ($before.Count -eq 0 -and -not (Get-TailMicHealth)) {
    Write-Ok 'TailMic is not running.'
    exit 0
}
# Ask nicely first: the server tells the window to close itself, then exits.
$r = Invoke-TailMic 'POST' '/api/quit' '{"confirm":true}'
if ($r) { Write-Host 'Closing the TailMic window and server...' }
$left = @()
for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 500
    $left = @(Get-TailMicProcesses)
    if ($left.Count -eq 0) { break }
}
# Anything still running after 8 seconds is closed by force.
foreach ($p in $left) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
}
if ($left.Count -gt 0) { Write-Warn2 "Force-closed $($left.Count) process(es) that did not exit on their own." }
Write-Ok 'TailMic stopped.'
