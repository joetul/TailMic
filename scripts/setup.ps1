# TailMic one-time setup for the Windows gaming PC.
# Safe to run again at any time (it only fixes what is missing).
param(
    [string]$AllowedUser   # optional: the allowed Tailscale login, so setup does not ask for it
)
. (Join-Path $PSScriptRoot 'common.ps1')

$problems = 0
Write-Host 'TailMic setup' -ForegroundColor White
Write-Host 'This sets up TailMic on this PC. It does not change Sunshine, Moonlight or your default audio devices.'

# Files that came from a downloaded zip are marked "from the internet"; clear that for
# TailMic's own files only. (Not for everything in this folder: if TailMic was extracted
# straight into Downloads, that would strip Windows' warning from unrelated downloads.)
$own = @(Get-ChildItem -Path $Script:Root -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*TailMic*.cmd' -or $_.Name -like 'Autostart-*.cmd' -or $_.Name -eq 'README.md' })
foreach ($sub in @('app', 'scripts', 'tests')) {
    $own += @(Get-ChildItem -Path (Join-Path $Script:Root $sub) -Recurse -File -ErrorAction SilentlyContinue)
}
$own | Unblock-File -ErrorAction SilentlyContinue
if (Test-OthersCanWrite $Script:Root) {
    Write-Warn2 "Other Windows accounts on this PC can change the files in $Script:Root."
    Write-Host '       That only matters if other people log in to this PC: TailMic runs these files as you.'
    Write-Host "       If so, move the TailMic folder into your own user folder ($env:USERPROFILE) and run Setup again."
}
Ensure-DataDir
$defaults = Read-Defaults
$firstTime = -not (Test-Path $Script:ConfigFile)   # false when Setup is run again, e.g. after an update

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

# Who may use TailMic: the Tailscale login of the CLIENT's user (the client is the computer you talk into).
$tags = @(Get-TailscaleSelfTags $st)
$login = ''
$suggest = @()
# The user saved earlier comes first, so running Setup again and pressing Enter changes nothing.
if (-not $firstTime) {
    try {
        foreach ($u in @((Get-Content -Raw $Script:ConfigFile | ConvertFrom-Json).allowedUsers)) {
            $u = ([string]$u).Trim().ToLower()
            if ($u -and -not (Get-LoginProblem $u $dns) -and ($suggest -notcontains $u)) { $suggest += $u }
        }
    } catch { }
}
if ($tags.Count -gt 0) {
    # A tagged device has no user of its own; what Tailscale reports as its "user"
    # (for example this PC's own name) must never be suggested.
    Write-Host "   This PC is a tagged Tailscale device ($($tags -join ', ')). That works, but a tagged device has no user,"
    Write-Host '   so the allowed user is the Tailscale login of the CLIENT (the computer you talk into).'
} else {
    $self = ([string](Get-TailscaleLogin $st)).Trim().ToLower()
    if ($self.Contains('@') -and -not (Get-LoginProblem $self $dns) -and ($suggest -notcontains $self)) { $suggest += $self }
}
foreach ($u in @(Get-TailscalePeerLogins $st $dns)) { if ($suggest -notcontains $u) { $suggest += $u } }

Write-Host ''
Write-Host '   Only ONE Tailscale user will be allowed to use TailMic.'
if ($AllowedUser) {
    $login = $AllowedUser.Trim().ToLower()
    $why = Get-LoginProblem $login $dns
    if ($why) {
        Write-Bad "-AllowedUser '$login' cannot be used: $why."
        exit 1
    }
    if (-not $login.Contains('@')) { Write-Warn2 "'$login' has no @, so it does not look like a Tailscale login. Using it because you asked for it." }
} else {
    if ($suggest.Count -gt 1) {
        Write-Host '   Tailscale logins found on this tailnet:'
        for ($i = 0; $i -lt $suggest.Count; $i++) { Write-Host "     $($i + 1). $($suggest[$i])" }
    }
    if ($suggest.Count -eq 0) {
        Write-Host '   Your login is shown in the Tailscale menu on the client (the computer you talk into), and at https://login.tailscale.com/admin/users'
        Write-Host '   Hard to type here (for example through Moonlight)? Press Enter to skip, and set it later'
        Write-Host '   from the client over SSH with:  TailMic.cmd set-user <login>'
    }
    while ($true) {
        if ($suggest.Count -eq 1) {
            $typed = (Read-Host "   Allowed user [$($suggest[0])] (press Enter to accept, or type another Tailscale login)").Trim()
            if (-not $typed) { $typed = $suggest[0] }
        } elseif ($suggest.Count -gt 1) {
            $typed = (Read-Host "   Allowed user: type a number, or a Tailscale login (press Enter for 1)").Trim()
            if (-not $typed) { $typed = '1' }
            if ($typed -match '^\d+$') {
                $n = [int]$typed
                if ($n -lt 1 -or $n -gt $suggest.Count) { Write-Warn2 "Type a number from 1 to $($suggest.Count), or a login."; continue }
                $typed = $suggest[$n - 1]
            }
        } else {
            $typed = (Read-Host '   Tailscale login of the client user (e.g. you@gmail.com)').Trim()
            if (-not $typed) { break }
        }
        $typed = $typed.ToLower()
        $why = Get-LoginProblem $typed $dns
        if ($why) { Write-Warn2 "'$typed' cannot be used: $why."; continue }
        if (-not $typed.Contains('@') -and -not (Ask-YesNo "   '$typed' has no @, so it does not look like a Tailscale login. Use it anyway?" $false)) { continue }
        $login = $typed
        break
    }
}
if ($login) {
    Write-Ok "Allowed Tailscale user: $login"
} else {
    $problems++
    Write-Bad 'No allowed user is set yet, so nobody can connect.'
    Write-Host "       Set it later (also over SSH):  `"$Script:Root\TailMic.cmd`" set-user <your Tailscale login>"
}

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
Write-Step '3/6  Browser for the TailMic window'
$browserPref = 'auto'
try { $browserPref = [string](Read-Config).receiverBrowser } catch { }
$browser = Get-ReceiverBrowser $browserPref
if (-not $browser) {
    if (Test-BrowserPath $browserPref) {
        Write-Bad "The browser set in ""receiverBrowser"" was not found: $browserPref"
        Write-Host "       Correct the path in $Script:ConfigFile (write it with forward slashes, like C:/Program Files/.../brave.exe),"
        Write-Host '       or set it to "auto" to use Chrome or Edge. Then run Setup again.'
    } else {
        Write-Bad "No usable browser found (setting: $browserPref). Microsoft Edge comes with Windows; Google Chrome is at https://www.google.com/chrome"
        Write-Host "       If you set ""receiverBrowser"" in $Script:ConfigFile, check it is ""auto"", ""chrome"", ""edge"","
        Write-Host '       or the full path of another Chromium-based browser.'
    }
    exit 1
}
Write-Ok "$($browser.Name) at $($browser.Exe) (uses its own TailMic profile; your normal browser is not touched)"

# ---------------------------------------------------------------- 4. Steam Streaming Microphone
Write-Step '4/6  Steam Streaming Microphone (the virtual mic games will use)'
$steamRunning = @(Get-Process -Name steam -ErrorAction SilentlyContinue).Count -gt 0
$eps = Get-SteamMicEndpoints
if ($eps.Count -gt 0) {
    foreach ($e in $eps) { Write-Ok "$($e.FriendlyName)  [$($e.Status)]" }
    if (-not (Show-SteamMicFormatCheck)) { $problems++ }
} else {
    $problems++
    Write-Bad 'Steam Streaming Microphone is not available yet.'
    if (-not $steamRunning) { Write-Host '       Steam is not running. Start Steam first.' }
    Write-Host '       ("Speakers (Steam Streaming Speakers)" is a different device and does not count.)'
    Write-Host '       Fix: Steam installs the device the first time you use Steam Remote Play:'
    Write-Host '         1. On this PC: Steam -> Settings -> Remote Play -> turn on "Enable Remote Play".'
    Write-Host '         2. On the client (the computer you talk into): install the free Steam Link app and connect to this PC once'
    Write-Host '            (type the PIN it shows here on the PC).'
    Write-Host '         3. Close Steam Link right away. Then run Setup again; it also checks the audio format.'
    Write-Host '       See README -> Troubleshooting.'
}

# ---------------------------------------------------------------- 5. Config + Tailscale Serve
Write-Step '5/6  TailMic settings and Tailscale Serve (HTTPS inside your tailnet only)'
$users = @()
if ($login) { $users = @($login) }
# serveHost: this PC's *.ts.net name; the server only answers requests for it.
Save-TailMicConfig @{ allowedUsers = $users; serveHost = $dns }
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
# Yes by default the first time; when Setup is run again, the default is what you chose before.
$autoDefault = $firstTime -or (Test-Path (Get-AutostartShortcut))
if (Ask-YesNo '   Start TailMic automatically when you log in to Windows?' $autoDefault) {
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
Write-Host ' On the client (the computer you talk into), open this address in Chrome or another Chromium-based browser (copied to clipboard):'
Write-Host "     $url" -ForegroundColor White
Write-Host ''
Write-Host ' In your game, choose the microphone:  Microphone (Steam Streaming Microphone)'
Write-Host ''
Write-Host ' Start / stop / check TailMic from anywhere (also over SSH):'
Write-Host "     `"$Script:Root\TailMic.cmd`" start | stop | status"
Write-Host '     (or double-click Start-TailMic.cmd, Stop-TailMic.cmd or Status-TailMic.cmd in the TailMic folder)'
Write-Host ' Update TailMic later (also over SSH):'
Write-Host "     `"$Script:Root\TailMic.cmd`" update        (or double-click Update-TailMic.cmd)"
Write-Host ' Change the allowed user (also over SSH, so you can paste the login):'
Write-Host "     `"$Script:Root\TailMic.cmd`" set-user <Tailscale login>"
Write-Host '=====================================================================' -ForegroundColor Cyan
