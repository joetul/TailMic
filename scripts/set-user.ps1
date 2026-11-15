# Set the one Tailscale user who may use TailMic, without any question to answer.
# Works over SSH, so the login can be pasted from the client (the computer you talk into):
#   TailMic.cmd set-user you@example.com
param(
    [Parameter(Position = 0)][string]$Login,
    [switch]$Force   # accept a login without "@"
)
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path $Script:ConfigFile)) {
    Write-Bad 'TailMic is not set up yet. Run Setup-TailMic.cmd once at the PC desktop (for example through Moonlight).'
    Write-Host '       You can press Enter at "Allowed user" there, and then run this command again.'
    exit 1
}
$cfg = Read-Config
$Login = ([string]$Login).Trim().ToLower()
if (-not $Login) {
    Write-Host 'Usage: TailMic.cmd set-user <Tailscale login>     for example: TailMic.cmd set-user you@example.com'
    $now = @($cfg.allowedUsers | Where-Object { $_ })
    if ($now.Count -gt 0) { Write-Host "Allowed user now: $($now -join ', ')" } else { Write-Host 'Allowed user now: none' }
    exit 2
}
$why = Get-LoginProblem $Login ([string]$cfg.serveHost)
if ($why) {
    Write-Bad "'$Login' cannot be used: $why."
    Write-Host '       Use the Tailscale login of the CLIENT user (the client is the computer you talk into). It is shown in the Tailscale menu there.'
    exit 1
}
if (-not $Login.Contains('@') -and -not $Force) {
    Write-Bad "'$Login' has no @, so it does not look like a Tailscale login. Nothing was changed."
    Write-Host "       If it really is the login, run:  TailMic.cmd set-user $Login -Force"
    exit 1
}

Save-TailMicConfig @{ allowedUsers = @($Login) }
Write-Ok "Allowed Tailscale user saved: $Login"

# The server reads the setting when it starts, so restart it if it is running.
if ((Get-TailMicHealth) -or (@(Get-TailMicProcesses).Count -gt 0)) {
    Write-Host 'Restarting TailMic so the change takes effect...'
    & (Join-Path $PSScriptRoot 'stop.ps1')
    & (Join-Path $PSScriptRoot 'start.ps1')
    exit $LASTEXITCODE
}
Write-Host '   TailMic is not running. The new user applies when it starts (TailMic.cmd start).'
exit 0
