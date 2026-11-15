# TailMic shared helpers (Windows PowerShell 5.1 compatible).
# 'Continue' on purpose: in Windows PowerShell 5.1, 'Stop' turns any stderr line
# from tailscale.exe or node.exe into a terminating error.
$ErrorActionPreference = 'Continue'

$Script:Root      = Split-Path -Parent $PSScriptRoot
$Script:AppDir    = Join-Path $Script:Root 'app'
$Script:ServerJs  = Join-Path $Script:AppDir 'server.js'
$Script:DataDir   = Join-Path $env:LOCALAPPDATA 'TailMic'
$Script:ConfigFile = Join-Path $Script:DataDir 'config.json'
$Script:LogDir    = Join-Path $Script:DataDir 'logs'
# Each browser gets its own TailMic-only profile (your normal browser profile is never used).
$Script:BrowserProfiles = @{ chrome = (Join-Path $Script:DataDir 'browser-chrome'); edge = (Join-Path $Script:DataDir 'browser-edge') }
# The profiles of TailMic 1.0. Its browser ran with a switch that let EVERY site in that
# profile use the microphone; they are only still known here so that stop can close such a
# window and start can remove them.
$Script:OldBrowserProfiles = @((Join-Path $Script:DataDir 'chrome-profile'), (Join-Path $Script:DataDir 'edge-profile'))

function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Write-Ok([string]$text)   { Write-Host "   OK  $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
function Write-Bad([string]$text)  { Write-Host "   XX  $text" -ForegroundColor Red }

function Ensure-DataDir {
    foreach ($d in @($Script:DataDir, $Script:LogDir)) {
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    }
}

function Read-Defaults {
    $f = Join-Path $Script:AppDir 'config.default.json'
    return (Get-Content -Raw -Path $f | ConvertFrom-Json)
}

function Read-Config {
    $cfg = Read-Defaults
    if (Test-Path $Script:ConfigFile) {
        $user = Get-Content -Raw -Path $Script:ConfigFile | ConvertFrom-Json
        foreach ($p in $user.PSObject.Properties) {
            $cfg | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force
        }
    }
    return $cfg
}

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Get-TailscaleExe {
    $c = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Get-TailscaleStatus([string]$ts) {
    try {
        $raw = & $ts status --json 2>$null | Out-String
        if (-not $raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Get-TailscaleLogin($st) {
    try {
        $uid = [string]$st.Self.UserID
        $u = $st.User.PSObject.Properties[$uid]
        if ($u) { return [string]$u.Value.LoginName }
    } catch { }
    return $null
}

function Get-TailscaleDnsName($st) {
    try { return ([string]$st.Self.DNSName).TrimEnd('.') } catch { return '' }
}

# The tags of this PC in Tailscale (empty for a normal, untagged device).
# A tagged device has no user of its own, so its "user" must never be suggested
# as the allowed user.
function Get-TailscaleSelfTags($st) {
    try { return @($st.Self.Tags | Where-Object { $_ }) } catch { return @() }
}

# Why $login cannot be a Tailscale user login; '' when nothing is wrong with it.
# $dns = this PC's *.ts.net name.
function Get-LoginProblem([string]$login, [string]$dns) {
    $l = ([string]$login).Trim().ToLower().TrimEnd('.')
    if (-not $l) { return 'it is empty' }
    if ($l -match '\s') { return 'it contains a space' }
    if ($l.StartsWith('tagged-devices')) { return 'that is what Tailscale calls tagged devices, not a user' }
    if ($l.EndsWith('.ts.net') -or ($dns -and $l -eq $dns.ToLower().TrimEnd('.'))) { return 'that is the name of a device, not a user login' }
    return ''
}

# Logins of the users who own the other, untagged devices this PC can see in the
# tailnet. One of them is almost certainly the client's user.
function Get-TailscalePeerLogins($st, [string]$dns) {
    $found = @()
    try {
        foreach ($p in $st.Peer.PSObject.Properties) {
            $peer = $p.Value
            if (@($peer.Tags | Where-Object { $_ }).Count -gt 0) { continue }
            $u = $st.User.PSObject.Properties[[string]$peer.UserID]
            if (-not $u) { continue }
            $l = ([string]$u.Value.LoginName).Trim().ToLower()
            if ($l.Contains('@') -and -not (Get-LoginProblem $l $dns) -and ($found -notcontains $l)) { $found += $l }
        }
    } catch { }
    return $found
}

# Change settings in config.json, keeping everything else that is in the file.
# $changes: a hashtable, for example @{ allowedUsers = @('you@example.com') }.
function Save-TailMicConfig($changes) {
    $cfgObj = [ordered]@{}
    if (Test-Path $Script:ConfigFile) {
        try {
            $old = Get-Content -Raw $Script:ConfigFile | ConvertFrom-Json
            foreach ($p in $old.PSObject.Properties) { $cfgObj[$p.Name] = $p.Value }
        } catch { }
    }
    foreach ($k in $changes.Keys) { $cfgObj[$k] = $changes[$k] }
    Ensure-DataDir
    Write-Utf8NoBom $Script:ConfigFile ($cfgObj | ConvertTo-Json -Depth 5)
}

function Get-ServeConfig([string]$ts) {
    try {
        $raw = & $ts serve status --json 2>$null | Out-String
        if (-not $raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

# Returns the proxy target configured for https://<dns>:<port>/ or $null.
function Get-ServeTarget($serveCfg, [string]$dns, [int]$port) {
    if (-not $serveCfg) { return $null }
    try {
        $web = $serveCfg.Web
        if (-not $web) { return $null }
        $site = $web.PSObject.Properties["${dns}:$port"]
        if (-not $site) { return $null }
        $h = $site.Value.Handlers.PSObject.Properties['/']
        if (-not $h) { return '(other)' }
        if ($h.Value.PSObject.Properties['Proxy']) { return [string]$h.Value.Proxy }
        return '(other)'
    } catch { return $null }
}

function Test-ServeFunnel($serveCfg, [string]$dns, [int]$port) {
    if (-not $serveCfg) { return $false }
    try {
        $af = $serveCfg.AllowFunnel
        if (-not $af) { return $false }
        $p = $af.PSObject.Properties["${dns}:$port"]
        return [bool]($p -and $p.Value)
    } catch { return $false }
}

function Get-NodeExe {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Get-NodeMajor([string]$node) {
    try {
        $v = (& $node --version 2>$null | Out-String).Trim()
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch { }
    return 0
}

function Get-ChromeExe {
    foreach ($k in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
        try {
            $v = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'
            if ($v -and (Test-Path $v)) { return $v }
        } catch { }
    }
    foreach ($p in @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                     "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                     "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Get-EdgeExe {
    foreach ($k in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')) {
        try {
            $v = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'
            if ($v -and (Test-Path $v)) { return $v }
        } catch { }
    }
    foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                     "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

# True when the "receiverBrowser" setting is the path of a browser program, not a name.
function Test-BrowserPath([string]$pref) {
    $p = ([string]$pref).Trim()
    return ($p.Contains('\') -or $p.Contains('/') -or $p.ToLower().EndsWith('.exe'))
}

# Picks the browser for the PC receiver window.
# $pref: 'auto' (Chrome if installed, otherwise Edge), 'chrome', 'edge', or the full
# path of another Chromium-based browser (Brave, Vivaldi, ...).
# Returns @{ Name; Key = 'chrome'|'edge'|'other'; Exe; Process; Profile } or $null.
function Get-ReceiverBrowser([string]$pref) {
    if (-not $pref) { $pref = 'auto' }
    if (Test-BrowserPath $pref) {
        # Any Chromium-based browser takes the same switches and the same prepared profile.
        $exe = $pref.Trim().Trim('"')
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
        $exe = (Resolve-Path -LiteralPath $exe).Path
        $file = Split-Path -Leaf $exe
        $short = ([System.IO.Path]::GetFileNameWithoutExtension($file).ToLower() -replace '[^a-z0-9]', '')
        if (-not $short) { $short = 'other' }
        $name = ''
        try { $name = [string][System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName } catch { }
        if (-not $name) { $name = $file }
        # Its own profile folder, named after the program (brave.exe -> browser-brave).
        return @{ Name = $name; Key = 'other'; Exe = $exe; Process = $file; Profile = (Join-Path $Script:DataDir "browser-$short") }
    }
    $pref = $pref.Trim().ToLower()
    $order = @('chrome', 'edge')
    if ($pref -eq 'edge') { $order = @('edge') }
    elseif ($pref -eq 'chrome') { $order = @('chrome') }
    foreach ($key in $order) {
        if ($key -eq 'chrome') {
            $exe = Get-ChromeExe
            if ($exe) { return @{ Name = 'Google Chrome'; Key = 'chrome'; Exe = $exe; Process = 'chrome.exe'; Profile = $Script:BrowserProfiles['chrome'] } }
        } else {
            $exe = Get-EdgeExe
            if ($exe) { return @{ Name = 'Microsoft Edge'; Key = 'edge'; Exe = $exe; Process = 'msedge.exe'; Profile = $Script:BrowserProfiles['edge'] } }
        }
    }
    return $null
}

# Prepare the TailMic-only browser profile so that TailMic's own page on this PC,
# and no other site, may use audio devices without asking. The page needs that to
# see the names of the audio devices (to find Steam's), and for "Test what the game
# hears". It works without anyone at the PC, and unlike a browser switch that
# accepts every request, a site opened in that profile by mistake gets nothing.
# The profile holds nothing worth keeping, so it is made anew when the port changes.
function Initialize-ReceiverProfile([string]$profileDir, [int]$receiverPort) {
    $origin = "http://127.0.0.1:$receiverPort"
    $marker = Join-Path $profileDir 'tailmic-origin.txt'
    if ((Test-Path $marker) -and ((Get-Content -Raw $marker).Trim() -eq $origin)) { return }
    if (-not $profileDir.StartsWith($Script:DataDir, [System.StringComparison]::OrdinalIgnoreCase)) { throw "unexpected profile folder: $profileDir" }
    if (Test-Path $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction Stop }
    $default = Join-Path $profileDir 'Default'
    New-Item -ItemType Directory -Path $default -Force | Out-Null
    $seed = (Get-Content -Raw (Join-Path $PSScriptRoot 'receiver-preferences.json')).Trim().Replace('{ORIGIN}', $origin)
    Write-Utf8NoBom (Join-Path $default 'Preferences') $seed
    Write-Utf8NoBom $marker $origin
}

# True when Windows accounts other than yours (and administrators) may change the
# files in $path. TailMic's scripts run as you, so on a PC that other people also
# log in to, such a folder would let them run programs as you.
function Test-OthersCanWrite([string]$path) {
    try {
        $write = [System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, ChangePermissions, TakeOwnership'
        $others = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')   # Everyone, Authenticated Users, Users
        $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
        foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ([string]$r.AccessControlType -ne 'Allow') { continue }
            if ($others -notcontains $r.IdentityReference.Value) { continue }
            if (($r.FileSystemRights -band $write) -ne 0) { return $true }
        }
    } catch { }
    return $false
}

function Test-PortOpen([int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne(300) -and $c.Connected) { $c.EndConnect($ar); return $true }
        return $false
    } catch { return $false } finally { $c.Close() }
}

# Steam Streaming Microphone endpoints that are currently present.
function Get-SteamMicEndpoints {
    try {
        return @(Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction Stop |
            Where-Object { $_.FriendlyName -like '*Steam Streaming Microphone*' })
    } catch { return @() }
}

# The audio format Windows uses for each half of the Steam Streaming Microphone:
# "Speakers (...)" (TailMic plays into it) and "Microphone (...)" (the game records it).
# Read-only, from the registry. Returns @{ Render = <format>; Capture = <format> };
# a half is $null when it could not be read. <format> = @{ Channels; Rate; Bits; Text }.
function Get-SteamMicFormats {
    $result = @{ Render = $null; Capture = $null }
    $base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio'
    $formatKey = '{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0'   # the endpoint's "Default Format"
    foreach ($flow in @('Render', 'Capture')) {
        try {
            foreach ($ep in @(Get-ChildItem -Path (Join-Path $base $flow) -ErrorAction Stop)) {
                $state = (Get-ItemProperty -Path $ep.PSPath -ErrorAction SilentlyContinue).DeviceState
                if ($state -ne 1) { continue }   # 1 = present and enabled
                $props = Get-Item -Path (Join-Path $ep.PSPath 'Properties') -ErrorAction SilentlyContinue
                if (-not $props) { continue }
                $isSteamMic = $false
                foreach ($n in $props.GetValueNames()) {
                    $v = $props.GetValue($n)
                    if ($v -is [string] -and $v -like '*Steam Streaming Microphone*') { $isSteamMic = $true; break }
                }
                if (-not $isSteamMic) { continue }
                $b = $props.GetValue($formatKey)
                if (-not ($b -is [byte[]]) -or $b.Length -lt 24) { continue }
                # 8 header bytes, then a WAVEFORMATEX structure.
                $ch = [int][BitConverter]::ToUInt16($b, 10)
                $rate = [int][BitConverter]::ToUInt32($b, 12)
                $bits = [int][BitConverter]::ToUInt16($b, 22)
                # Only trust values that look like a real audio format.
                if ($ch -lt 1 -or $ch -gt 8 -or $rate -lt 8000 -or $rate -gt 384000 -or (@(8, 16, 24, 32) -notcontains $bits)) { continue }
                $result[$flow] = @{ Channels = $ch; Rate = $rate; Bits = $bits; Text = "$ch channel, $bits bit, $rate Hz" }
                break
            }
        } catch { }
    }
    return $result
}

# Steam's virtual microphone copies sound from its "Speakers" half to its
# "Microphone" half without converting it. If the two halves are set to different
# formats, the game ALWAYS hears it wrong: stereo read as mono plays at half speed
# (slow and deep), 48000 Hz read as 44100 Hz plays about 8% too slow, with crackle.
# So a mismatch is an error. Returns $true when the formats match or could not be read.
function Show-SteamMicFormatCheck {
    $f = Get-SteamMicFormats
    $r = $f.Render
    $c = $f.Capture
    if (-not $r -or -not $c) { return $true }
    if ($r.Channels -eq $c.Channels -and $r.Rate -eq $c.Rate -and $r.Bits -eq $c.Bits) {
        Write-Ok "Steam Streaming Microphone format: $($r.Text) (both halves match)"
        return $true
    }
    Write-Bad 'The two halves of the Steam Streaming Microphone use different audio formats.'
    Write-Host '       The game then hears your voice slow, deep ("dark") or garbled.'
    Write-Host "       Speakers (Steam Streaming Microphone):   $($r.Text)"
    Write-Host "       Microphone (Steam Streaming Microphone): $($c.Text)   <-- change this one"
    Write-Host '       Fix: Settings -> System -> Sound -> More sound settings -> Recording tab ->'
    Write-Host '       "Microphone (Steam Streaming Microphone)" -> Properties -> Advanced. Set Default Format to:'
    Write-Host "           $($r.Text)" -ForegroundColor White
    Write-Host '       Channels, bits and Hz must ALL be the same; matching only the Hz is not enough.'
    Write-Host '       (The Playback tab does not show the channel count of the Speakers half. Use the line above.)'
    Write-Host '       Then run "TailMic.cmd stop" and "TailMic.cmd start", check with "TailMic.cmd status",'
    Write-Host '       and restart the game.'
    return $false
}

function Get-TailMicProcesses {
    $out = @()
    try {
        # node.exe, Chrome, Edge, and the browser named by a path in the settings (if any).
        $names = @('node.exe', 'chrome.exe', 'msedge.exe')
        try {
            $pref = [string](Read-Config).receiverBrowser
            if (Test-BrowserPath $pref) {
                $other = Split-Path -Leaf $pref.Trim().Trim('"')
                if ($other -and ($other -notmatch "'") -and ($names -notcontains $other.ToLower())) { $names += $other }
            }
        } catch { }
        $filter = (@($names | ForEach-Object { "Name='$_'" }) -join ' OR ')
        # Every TailMic browser profile is a folder "browser-..." in TailMic's data folder.
        $profiles = @((Join-Path $Script:DataDir 'browser-')) + $Script:OldBrowserProfiles
        $all = Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop
        foreach ($p in $all) {
            $cl = [string]$p.CommandLine
            if (-not $cl) { continue }
            if ($p.Name -eq 'node.exe') {
                if ($cl.Contains($Script:ServerJs)) { $out += $p }
            } else {
                foreach ($prof in $profiles) {
                    if ($cl.Contains($prof)) { $out += $p; break }
                }
            }
        }
    } catch { }
    return $out
}

function Ask-YesNo([string]$question, [bool]$default = $true) {
    $suffix = '[y/N]'
    if ($default) { $suffix = '[Y/n]' }
    $a = Read-Host "$question $suffix"
    if (-not $a) { return $default }
    return ($a.Trim().ToLower().StartsWith('y'))
}

# ---------------------------------------------------------------- desktop / SSH helpers
$Script:TaskName = 'TailMic'

# True when this script runs in the Windows desktop session (not over SSH).
function Test-OnDesktop {
    try {
        $mine = (Get-Process -Id $PID).SessionId
        return @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $mine }).Count -gt 0
    } catch { return $true }
}

# This Windows user as Windows itself knows it ("PC\name"), and its SID.
# Not built from $env:USERDOMAIN and $env:USERNAME: in an OpenSSH session those do
# not always name a real account (USERDOMAIN can be WORKGROUP), and Windows then
# answers "No mapping between account names and security IDs was done".
function Get-CurrentUserName { return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name }
function Get-CurrentUserSid { return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

# True when this Windows user is logged in on the desktop (screen may be locked).
function Test-UserLoggedOn {
    try {
        $sid = Get-CurrentUserSid
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop)) {
            $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
            if ($o.Sid -eq $sid) { return $true }
        }
        return $false
    } catch { return $true }
}

# The command that starts TailMic without any visible console window.
function Get-HiddenStartCommand {
    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $start = Join-Path $PSScriptRoot 'start.ps1'
    return @{
        Exe  = "$env:SystemRoot\System32\conhost.exe"
        Args = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`" -Autostart"
    }
}

# The "start with Windows" shortcut (it exists only while autostart is on).
function Get-AutostartShortcut { return (Join-Path ([Environment]::GetFolderPath('Startup')) 'TailMic.lnk') }

# An on-demand scheduled task that runs start.ps1 in YOUR desktop session.
# That is how TailMic is started over SSH: programs started directly from an
# SSH session are not on the desktop and cannot play audio there.
function Register-TailMicTask {
    $c = Get-HiddenStartCommand
    $action = New-ScheduledTaskAction -Execute $c.Exe -Argument $c.Args -WorkingDirectory $Script:Root
    $principal = New-ScheduledTaskPrincipal -UserId (Get-CurrentUserName) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $Script:TaskName -Action $action -Principal $principal -Settings $settings `
        -Description 'Starts TailMic (microphone over Tailscale -> Steam Streaming Microphone). Run on demand, e.g. over SSH.' -Force -ErrorAction Stop | Out-Null
}

# The "TailMic" scheduled task, or $null when there is none.
function Get-TailMicTask {
    try { return (Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction Stop | Select-Object -First 1) } catch { return $null }
}

# True when the task starts THIS copy of TailMic (false after the folder was moved).
function Test-TailMicTaskCurrent($task) {
    try {
        $c = Get-HiddenStartCommand
        $a = @($task.Actions)[0]
        return ([string]$a.Execute -eq $c.Exe -and [string]$a.Arguments -eq $c.Args)
    } catch { return $false }
}

# Talk to the local TailMic server (no proxy). Returns the parsed JSON or $null.
function Invoke-TailMic([string]$method, [string]$path, [string]$body = $null) {
    try {
        $cfg = Read-Config
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$([int]$cfg.receiverPort)$path")
        $req.Method = $method
        $req.Proxy = $null
        $req.Timeout = 3000
        if ($body) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $req.ContentType = 'application/json'
            $req.ContentLength = $bytes.Length
            $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
        }
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $reader.ReadToEnd()
        $resp.Close()
        return ($text | ConvertFrom-Json)
    } catch { return $null }
}

function Get-TailMicHealth { return (Invoke-TailMic 'GET' '/api/health') }

# Wait until the server runs, the PC window is connected and the Steam device is found.
function Wait-TailMicReady([int]$seconds) {
    $h = $null
    for ($i = 0; $i -lt ($seconds * 2); $i++) {
        $h = Get-TailMicHealth
        if ($h -and $h.receiverWindow -and ($h.outputDevice -or $h.needsPermission)) { return $h }
        Start-Sleep -Milliseconds 500
    }
    return $h
}

# ---------------------------------------------------------------- update helpers
# True when $dir holds TailMic (its main files are there).
function Test-TailMicFolder([string]$dir) {
    foreach ($f in @('TailMic.cmd', (Join-Path 'app' 'server.js'), (Join-Path 'scripts' 'start.ps1'))) {
        if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { return $false }
    }
    return $true
}

# The version number of the TailMic in $dir.
function Get-FolderVersion([string]$dir) {
    try { return [string](Get-Content -Raw (Join-Path (Join-Path $dir 'app') 'package.json') | ConvertFrom-Json).version } catch { return 'unknown' }
}

# The files in $from that are missing in $to or different there (as paths inside $from).
function Get-ChangedFiles([string]$from, [string]$to) {
    $out = @()
    $base = (Resolve-Path -LiteralPath $from).Path.TrimEnd('\', '/')
    foreach ($f in @(Get-ChildItem -LiteralPath $base -Recurse -File)) {
        $rel = $f.FullName.Substring($base.Length + 1)
        $target = Join-Path $to $rel
        if (-not (Test-Path -LiteralPath $target) -or ((Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $target).Hash)) { $out += $rel }
    }
    return $out
}

# Version and fingerprint of the TailMic files in THIS folder (see buildInfo in
# server.js): @{ Version; Id }, or $null when Node.js is not available.
function Get-InstalledBuild {
    $node = Get-NodeExe
    if (-not $node) { return $null }
    try {
        $out = (& $node $Script:ServerJs --build 2>$null | Out-String).Trim()
        if ($out -match '^(\S+) ([0-9a-f]{12})$') { return @{ Version = $Matches[1]; Id = $Matches[2] } }
    } catch { }
    return $null
}

# Print a short status. Returns $true if TailMic is ready to use.
function Show-TailMicStatus($h) {
    if (-not $h) {
        Write-Bad 'TailMic server: not running'
        return $false
    }
    # After an update, the running TailMic must be the files in this folder.
    $ver = ''
    if ($h.version) { $ver = " (version $($h.version))" }
    $current = $true
    $mine = Get-InstalledBuild
    if ($mine -and ([string]$h.build -ne $mine.Id)) {
        $current = $false
        Write-Bad "TailMic server: running$ver, but NOT the files in this folder (version $($mine.Version))"
        if ($h.appDir -and ([string]$h.appDir).TrimEnd('\') -ne $Script:AppDir.TrimEnd('\')) {
            Write-Host "       It is running from: $($h.appDir)"
            Write-Host "       This folder:        $Script:AppDir"
        }
        Write-Host '       TailMic was updated but not restarted. Run:  TailMic.cmd stop   and then   TailMic.cmd start'
    } else {
        Write-Ok "TailMic server: running$ver"
    }
    if (-not $h.receiverWindow) { Write-Bad 'PC window: not connected (run start again)' }
    elseif ($h.needsPermission) {
        Write-Bad 'PC window: open, but it is waiting for permission to use audio devices.'
        Write-Host '       At the PC desktop (for example through Moonlight), click "Allow" in the TailMic window. Needed once.'
    } else { Write-Ok 'PC window: open' }
    $formatOk = $true
    if ($h.outputDevice) { Write-Ok "Output: $($h.outputDevice)"; $formatOk = Show-SteamMicFormatCheck } else { Write-Bad 'Output: Steam Streaming Microphone NOT FOUND (is Steam running?)' }
    $users = @($h.allowedUsers | Where-Object { $_ })
    if ($users.Count -gt 0) { Write-Ok "Allowed user: $($users -join ', ')" }
    else { Write-Bad 'Allowed user: NONE, so nobody can connect. Set it with:  TailMic.cmd set-user <your Tailscale login>' }
    if ($h.call) { Write-Ok "Call: $($h.call.user) ($($h.call.state))" } else { Write-Host '   --  Call: none (connect from the client)' }
    if ($h.test) { Write-Warn2 'Test running: the client is listening to "Microphone (Steam Streaming Microphone)"' }
    if ($h.serveHost) { Write-Host "   Client address: https://$($h.serveHost):$($h.httpsPort)" }
    return [bool]($current -and $h.receiverWindow -and $h.outputDevice -and $formatOk -and $users.Count -gt 0)
}
