# TailMic one-time setup for the Windows gaming PC.
# Safe to run again at any time (it only fixes what is missing).
. (Join-Path $PSScriptRoot 'common.ps1')

$problems = 0
Write-Host 'TailMic setup' -ForegroundColor White
Write-Host 'This sets up TailMic on this PC. It does not change Sunshine, Moonlight or your default audio devices.'

# Files that came from a downloaded zip are marked "from the internet"; clear that for our own files.
Get-ChildItem -Path $Script:Root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
Ensure-DataDir
$defaults = Read-Defaults

# ---------------------------------------------------------------- 1. Tailscale
Write-Step '1/6  Tailscale'
$ts = Get-TailscaleExe
if (-not $ts) {
    Write-Bad 'Tailscale is not installed. Install it from https://tailscale.com/download/windows, sign in, then run Setup again.'
    exit 1
}
$st = Get-TailscaleStatus $ts
if (-not $st -or [string]$st.BackendState -ne 'Running') {
    Write-Bad 'Tailscale is not connected. Open Tailscale from the system tray, sign in / connect, then run Setup again.'
    exit 1
}
$dns = Get-TailscaleDnsName $st
if (-not $dns -or -not $dns.EndsWith('.ts.net')) {
    Write-Bad 'MagicDNS is off, so this PC has no *.ts.net name.'
    Write-Host '       Turn it on: https://login.tailscale.com/admin/dns -> "Enable MagicDNS" and "Enable HTTPS". Then run Setup again.'
    exit 1
}
Write-Ok "This PC on the tailnet: $dns"

$login = Get-TailscaleLogin $st
if (-not $login -or $login -like 'tagged-devices*') {
    Write-Warn2 'Could not read your Tailscale login from this PC (it may be a tagged device).'
    $login = ''
}
$existing = @()
if (Test-Path $Script:ConfigFile) {
    try { $existing = @((Get-Content -Raw $Script:ConfigFile | ConvertFrom-Json).allowedUsers) } catch { }
}
if (-not $login -and $existing.Count -gt 0) { $login = [string]$existing[0] }
Write-Host ''
Write-Host '   Only ONE Tailscale user will be allowed to use TailMic.'
if ($login) {
    $typed = Read-Host "   Allowed user [$login] (press Enter to accept, or type another Tailscale login)"
    if ($typed.Trim()) { $login = $typed.Trim() }
} else {
    while (-not $login) { $login = (Read-Host '   Type your Tailscale login (e.g. you@gmail.com)').Trim() }
}
$login = $login.ToLower()
Write-Ok "Allowed Tailscale user: $login"

# ---------------------------------------------------------------- 2. Node.js
Write-Step '2/6  Node.js (runs the small TailMic server)'
$node = Get-NodeExe
$major = 0
if ($node) { $major = Get-NodeMajor $node }
if (-not $node -or $major -lt 18) {
    if ($node) { Write-Warn2 "Node.js $major is too old (need 18 or newer)." } else { Write-Warn2 'Node.js is not installed.' }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget -and (Ask-YesNo '   Install Node.js LTS now with winget (official package OpenJS.NodeJS.LTS)?' $true)) {
        & winget.exe install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
        $node = Get-NodeExe
        if ($node) { $major = Get-NodeMajor $node }
    }
    if (-not $node -or $major -lt 18) {
        Write-Bad 'Node.js is still missing. Install the LTS version from https://nodejs.org and run Setup again.'
        exit 1
    }
}
Write-Ok "Node.js v$major at $node"

# ---------------------------------------------------------------- 3. Browser
Write-Step '3/6  Browser for the TailMic window (Chrome or Edge)'
$browserPref = 'auto'
try { $browserPref = [string](Read-Config).receiverBrowser } catch { }
$browser = Get-ReceiverBrowser $browserPref
if (-not $browser) {
    Write-Bad "No usable browser found (setting: $browserPref). Microsoft Edge comes with Windows; Google Chrome is at https://www.google.com/chrome"
    Write-Host "       If you set ""receiverBrowser"" in $Script:ConfigFile, check it is ""auto"", ""chrome"" or ""edge""." 
    exit 1
}
Write-Ok "$($browser.Name) at $($browser.Exe) (uses its own TailMic profile; your normal browser is not touched)"

# ---------------------------------------------------------------- 4. Steam Streaming Microphone
Write-Step '4/6  Steam Streaming Microphone (the virtual mic games will use)'
$steamRunning = @(Get-Process -Name steam -ErrorAction SilentlyContinue).Count -gt 0
$eps = Get-SteamMicEndpoints
if ($eps.Count -gt 0) {
    foreach ($e in $eps) { Write-Ok "$($e.FriendlyName)  [$($e.Status)]" }
    [void](Show-SteamMicFormatCheck)
} else {
    $problems++
    Write-Bad 'Steam Streaming Microphone is not available yet.'
    if (-not $steamRunning) { Write-Host '       Steam is not running. Start Steam first.' }
    Write-Host '       Fix: with Steam running on this PC, do ONE short Steam Remote Play session to this PC'
    Write-Host '       (for example with the free Steam Link app on your laptop). Steam installs its streaming'
    Write-Host '       audio devices the first time. Then run Setup again. See README -> Troubleshooting.'
}

# ---------------------------------------------------------------- 5. Config + Tailscale Serve
Write-Step '5/6  TailMic settings and Tailscale Serve (HTTPS inside your tailnet only)'
$cfgObj = [ordered]@{ allowedUsers = @($login) }
if (Test-Path $Script:ConfigFile) {
    try {
        $old = Get-Content -Raw $Script:ConfigFile | ConvertFrom-Json
        foreach ($p in $old.PSObject.Properties) { if ($p.Name -ne 'allowedUsers') { $cfgObj[$p.Name] = $p.Value } }
    } catch { }
}
$cfgObj['serveHost'] = $dns   # this PC's *.ts.net name; the server only answers requests for it
Write-Utf8NoBom $Script:ConfigFile ($cfgObj | ConvertTo-Json -Depth 5)
$cfg = Read-Config
Write-Ok "Settings saved to $Script:ConfigFile"

$httpsPort = [int]$cfg.httpsPort
$target = "http://127.0.0.1:$([int]$cfg.clientPort)"
$serve = Get-ServeConfig $ts
$current = Get-ServeTarget $serve $dns $httpsPort
if (Test-ServeFunnel $serve $dns $httpsPort) {
    Write-Bad "Tailscale FUNNEL (public internet) is enabled on port $httpsPort. TailMic will not run on a public port."
    Write-Host "       Turn it off with:  tailscale funnel --https=$httpsPort off   then run Setup again."
    exit 1
}
if ($current -and $current -ne $target) {
    Write-Bad "Port $httpsPort on $dns is already used by another Tailscale Serve app ($current)."
    Write-Host "       Pick a free port: edit $Script:ConfigFile, add  ""httpsPort"": 8444  and run Setup again."
    exit 1
}
if ($current -eq $target) {
    Write-Ok "Already serving https://${dns}:$httpsPort -> $target"
} else {
    Write-Host "   Running: tailscale serve --bg --https=$httpsPort $target"
    Write-Host '   (If Tailscale prints a link to enable Serve/HTTPS, open it, click Enable, and wait here.)'
    & $ts serve --bg "--https=$httpsPort" $target
    $serve = Get-ServeConfig $ts
    if ((Get-ServeTarget $serve $dns $httpsPort) -eq $target) {
        Write-Ok "Serving https://${dns}:$httpsPort -> $target (tailnet only; remembered across reboots)"
    } else {
        $problems++
        Write-Bad 'Tailscale Serve is not set up. Check the message above, then run Setup again.'
    }
}

# ---------------------------------------------------------------- 6. First start + autostart
Write-Step '6/6  First start'
# On-demand task so TailMic can be started over SSH (it runs in your desktop session).
try { Register-TailMicTask; Write-Ok 'Created the "TailMic" scheduled task (used by "TailMic.cmd start" over SSH).' }
catch { $problems++; Write-Bad "Could not create the TailMic scheduled task: $($_.Exception.Message)" }
Write-Host '   Starting TailMic. A small "TailMic (PC)" window opens minimized; you never need to touch it.'
& (Join-Path $PSScriptRoot 'start.ps1') -FirstRun
if ($LASTEXITCODE -ne 0) { $problems++ }
Write-Host ''
if (Ask-YesNo '   Start TailMic automatically when you log in to Windows?' $true) {
    & (Join-Path $PSScriptRoot 'autostart.ps1') -Enable
} else {
    Write-Host '   OK. You can turn it on later with Autostart-On.cmd'
}

$url = "https://${dns}:$httpsPort"
try { Set-Clipboard -Value $url } catch { }
Write-Host ''
Write-Host '=====================================================================' -ForegroundColor Cyan
if ($problems -eq 0) { Write-Host ' Setup complete.' -ForegroundColor Green } else { Write-Host " Setup finished with $problems problem(s) - see the red lines above." -ForegroundColor Yellow }
Write-Host ''
Write-Host ' On your Mac / laptop, open this address in Chrome (copied to clipboard):'
Write-Host "     $url" -ForegroundColor White
Write-Host ''
Write-Host ' In your game, choose the microphone:  Microphone (Steam Streaming Microphone)'
Write-Host ''
Write-Host ' Start / stop / check TailMic from anywhere (also over SSH):'
Write-Host "     `"$Script:Root\TailMic.cmd`" start | stop | status"
Write-Host '=====================================================================' -ForegroundColor Cyan
