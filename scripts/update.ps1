# Update TailMic: download the latest files from GitHub over the ones in this folder,
# and restart TailMic if it was running. Works at the PC desktop and over SSH.
# Settings are not touched: they live in %LOCALAPPDATA%\TailMic, not in this folder.
param(
    [string]$FromZip   # for the tests: use this zip file instead of downloading one
)
. (Join-Path $PSScriptRoot 'common.ps1')
$zipUrl = 'https://github.com/joetul/TailMic/archive/refs/heads/main.zip'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "TailMic-update-$PID"
$download = "$tmp.zip"

function Update-TailMic {
    if (Test-Path (Join-Path $Script:Root '.git')) {
        Write-Bad 'This TailMic folder is a git clone, so it is updated with git, not with this command.'
        Write-Host '       Run "git pull" in it, then "TailMic.cmd stop" and "TailMic.cmd start".'
        return 1
    }
    $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Windows PowerShell downloads very slow
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try {
        if ($FromZip) { Copy-Item -LiteralPath $FromZip -Destination $download -ErrorAction Stop }
        else {
            Write-Host "Downloading the latest TailMic from $zipUrl"
            Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $download -ErrorAction Stop
        }
        Expand-Archive -LiteralPath $download -DestinationPath $tmp -Force -ErrorAction Stop
    } catch {
        Write-Bad "Could not download TailMic: $($_.Exception.Message)"
        Write-Host '       Nothing was changed. Check that this PC can reach github.com, then try again.'
        return 1
    }
    # Only go on if the download really is TailMic (one folder with its main files).
    $found = @(Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { Test-TailMicFolder $_.FullName })
    if ($found.Count -ne 1) {
        Write-Bad 'The download does not look like TailMic. Nothing was changed.'
        return 1
    }
    $src = $found[0].FullName
    $oldVer = Get-FolderVersion $Script:Root
    $newVer = Get-FolderVersion $src
    $changed = @(Get-ChangedFiles $src $Script:Root)
    if ($changed.Count -eq 0) {
        Write-Ok "TailMic is already up to date (version $oldVer)."
        return 0
    }

    # Stop with the old files, replace them, start with the new ones.
    $wasRunning = [bool]((Get-TailMicHealth) -or (@(Get-TailMicProcesses).Count -gt 0))
    if ($wasRunning) { & (Join-Path $PSScriptRoot 'stop.ps1') }
    try {
        Copy-Item -Path (Join-Path $src '*') -Destination $Script:Root -Recurse -Force -ErrorAction Stop
    } catch {
        Write-Bad "Could not replace the TailMic files: $($_.Exception.Message)"
        Write-Host '       Some files may be new and some old. Close anything that has TailMic files open and run the update again.'
        return 1
    }
    if ($oldVer -eq $newVer) { Write-Ok "TailMic updated (version $newVer, $($changed.Count) file(s) changed)." }
    else { Write-Ok "TailMic updated: version $oldVer -> $newVer ($($changed.Count) file(s) changed)." }
    if (-not $wasRunning) {
        Write-Host '   TailMic was not running. The new version is used the next time it starts (TailMic.cmd start).'
        return 0
    }
    # In a new PowerShell, so that nothing of the old scripts is still in use.
    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start.ps1') | Out-Host
    return $LASTEXITCODE
}

$code = @(Update-TailMic)[-1]
Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
exit $code
