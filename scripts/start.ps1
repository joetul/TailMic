# Start TailMic on the gaming PC: the local server (hidden) + the receiver window.
# Works from the desktop AND over SSH (then it starts TailMic in your desktop
# session through the "TailMic" scheduled task). Never waits for a key press.
param(
    [switch]$FirstRun,   # used by Setup: show the window normally once
    [switch]$Autostart   # used at login / by the scheduled task: wait for Tailscale
)
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path $Script:ConfigFile)) {
    Write-Bad 'TailMic is not set up yet. Run Setup-TailMic.cmd first (at the PC desktop, e.g. through Moonlight).'
    exit 1
}
Ensure-DataDir

# ---- Over SSH (not on the desktop): start TailMic in the desktop session instead.
if (-not (Test-OnDesktop)) {
    if (-not (Test-UserLoggedOn)) {
        Write-Bad "Nobody is logged in to Windows as $(Get-CurrentUserName). Log in first (for example through Moonlight), then try again."
        exit 1
    }
    $h = Get-TailMicHealth
    if (-not ($h -and $h.receiverWindow)) {
        # Setup already created the task. Only (re)create it when it is missing or
        # points at another folder; if that fails, an existing task is still used.
        $task = Get-TailMicTask
        if (-not $task -or -not (Test-TailMicTaskCurrent $task)) {
            try { Register-TailMicTask }
            catch {
                if (-not $task) {
                    Write-Bad "Could not create the TailMic scheduled task: $($_.Exception.Message)"
                    Write-Host '       Run Setup-TailMic.cmd once at the PC desktop (for example through Moonlight); it creates the task.'
                    exit 1
                }
                Write-Warn2 "Could not update the TailMic scheduled task ($($_.Exception.Message)). Using the existing one."
            }
        }
        Write-Host 'Starting TailMic on the PC desktop...'
        try { Start-ScheduledTask -TaskName $Script:TaskName -ErrorAction Stop }
        catch { Write-Bad "Could not start the TailMic scheduled task: $($_.Exception.Message)"; exit 1 }
        $h = Wait-TailMicReady 60
    }
    if (Show-TailMicStatus $h) { exit 0 } else { exit 1 }
}
$cfg = Read-Config
$clientPort = [int]$cfg.clientPort
$receiverPort = [int]$cfg.receiverPort

# ---- Tailscale (warn only: the server itself does not need it to start)
$ts = Get-TailscaleExe
$tries = 1
if ($Autostart) { $tries = 30 }   # up to ~60 s after login
$st = $null
$dns = ''
if ($ts) {
    for ($i = 0; $i -lt $tries; $i++) {
        $st = Get-TailscaleStatus $ts
        if ($st -and [string]$st.BackendState -eq 'Running') { break }
        Start-Sleep -Seconds 2
    }
}
if (-not $st -or [string]$st.BackendState -ne 'Running') {
    Write-Warn2 'Tailscale is not connected right now. TailMic will work as soon as it is.'
} else {
    $dns = Get-TailscaleDnsName $st
    $target = "http://127.0.0.1:$clientPort"
    $serve = Get-ServeConfig $ts
    $cur = Get-ServeTarget $serve $dns ([int]$cfg.httpsPort)
    if (Test-ServeFunnel $serve $dns ([int]$cfg.httpsPort)) {
        # Same rule as Setup: never run on a port that is public through Funnel.
        Write-Bad "Tailscale FUNNEL (public internet) is on for port $($cfg.httpsPort). TailMic will not set up Serve there."
        Write-Host "       Turn it off with:  tailscale funnel --https=$($cfg.httpsPort) off   then start TailMic again."
        Write-Host '       (TailMic refuses Funnel visitors anyway: they carry no Tailscale identity.)'
    } elseif (-not $cur) {
        Write-Warn2 'Tailscale Serve was not set up for TailMic; setting it up again.'
        & $ts serve --bg "--https=$([int]$cfg.httpsPort)" $target | Out-Null
    } elseif ($cur -ne $target) {
        Write-Warn2 "Port $($cfg.httpsPort) is used by another Tailscale Serve app ($cur). Run Setup-TailMic again."
    }
    Write-Host "Laptop address: https://${dns}:$($cfg.httpsPort)"
}

# ---- Server
if ((Test-PortOpen $clientPort) -or (Test-PortOpen $receiverPort)) {
    $mine = @(Get-TailMicProcesses | Where-Object { $_.Name -eq 'node.exe' })
    if ($mine.Count -eq 0) {
        Write-Bad "Port $clientPort or $receiverPort is used by another program. Change clientPort/receiverPort in $Script:ConfigFile."
        exit 1
    }
    Write-Ok 'TailMic server is already running.'
} else {
    $node = Get-NodeExe
    if (-not $node) {
        Write-Bad 'Node.js not found. Run Setup-TailMic.cmd again.'
        exit 1
    }
    $stamp = Get-Date -Format 'yyyyMMdd'
    $out = Join-Path $Script:LogDir "server-$stamp.log"
    $err = Join-Path $Script:LogDir "server-$stamp.err.log"
    # Remove logs older than 14 days.
    Get-ChildItem $Script:LogDir -Filter 'server-*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -ErrorAction SilentlyContinue
    # The server appends its own log ($out); stderr ($err) only catches crashes.
    $nodeArgs = "`"$Script:ServerJs`" --config `"$Script:ConfigFile`" --log `"$out`""
    # tailscale.exe lets the server read this PC's exact Tailscale IPs; the name pins the Host header.
    if ($ts) { $nodeArgs += " --tailscale `"$ts`"" }
    if ($dns) { $nodeArgs += " --serve-host `"$dns`"" }
    Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $Script:AppDir -WindowStyle Hidden `
        -RedirectStandardError $err | Out-Null
    $up = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 200
        if (Test-PortOpen $receiverPort) { $up = $true; break }
    }
    if (-not $up) {
        Write-Bad "TailMic server did not start. See $out and $err"
        if (Test-Path $out) { Get-Content $out -Tail 10 }
        if (Test-Path $err) { Get-Content $err -Tail 20 }
        exit 1
    }
    Write-Ok 'TailMic server started.'
}

# ---- Receiver window (Chrome or Edge, with a TailMic-only profile separate from your normal browser)
$browser = Get-ReceiverBrowser ([string]$cfg.receiverBrowser)
if (-not $browser) {
    Write-Bad "No usable browser found (receiverBrowser = '$($cfg.receiverBrowser)'). Run Setup-TailMic.cmd again."
    exit 1
}
$browserArgs = @(
    "--user-data-dir=`"$($browser.Profile)`"",
    "--app=http://127.0.0.1:$receiverPort/",
    '--window-size=480,640',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    # No switch that lets every site use the microphone: the profile itself allows
    # TailMic's own page only (see Initialize-ReceiverProfile).
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'
) -join ' '
$style = 'Minimized'
if ($FirstRun) { $style = 'Normal' }
$running = @(Get-TailMicProcesses | Where-Object { $_.Name -eq $browser.Process })
if ($running.Count -gt 0 -and -not $FirstRun) {
    Write-Ok 'TailMic receiver window is already open.'
} else {
    if ($running.Count -eq 0) {
        try { Initialize-ReceiverProfile $browser.Profile $receiverPort }
        catch { Write-Warn2 "Could not prepare the TailMic browser profile ($($_.Exception.Message)). The TailMic window may ask for permission once." }
        # Left over from TailMic 1.0 (see common.ps1); nothing in them is worth keeping.
        if (@(Get-TailMicProcesses | Where-Object { $_.Name -ne 'node.exe' }).Count -eq 0) {
            foreach ($old in $Script:OldBrowserProfiles) {
                if (Test-Path $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
    }
    Start-Process -FilePath $browser.Exe -ArgumentList $browserArgs -WindowStyle $style | Out-Null
    Write-Ok "TailMic receiver window opened in $($browser.Name) (minimized; you never need to touch it)."
}

# ---- Report
$h = Wait-TailMicReady 20
if (Show-TailMicStatus $h) { exit 0 } else { exit 1 }
