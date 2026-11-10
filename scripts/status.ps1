# Show whether TailMic is running and ready (works over SSH).
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Test-Path $Script:ConfigFile)) { Write-Bad 'TailMic is not set up yet (run Setup-TailMic.cmd).'; exit 1 }
if (Show-TailMicStatus (Get-TailMicHealth)) { exit 0 } else { exit 1 }
