# Turn "start TailMic when I log in to Windows" on or off (no admin needed).
param([switch]$Enable, [switch]$Disable)
. (Join-Path $PSScriptRoot 'common.ps1')
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'TailMic.lnk'
if ($Disable) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
    Write-Ok 'TailMic will no longer start with Windows.'
    exit 0
}
if ($Enable) {
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    # conhost --headless: no console window flashes up at login.
    $c = Get-HiddenStartCommand
    $s.TargetPath = $c.Exe
    $s.Arguments = $c.Args
    $s.WorkingDirectory = $Script:Root
    $s.WindowStyle = 7
    $s.Description = 'Start TailMic (laptop microphone -> Steam Streaming Microphone)'
    $s.Save()
    Write-Ok "TailMic will start when you log in ($lnk)."
    exit 0
}
Write-Host 'Use -Enable or -Disable.'
