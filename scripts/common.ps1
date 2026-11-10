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
$Script:BrowserProfiles = @{ chrome = (Join-Path $Script:DataDir 'chrome-profile'); edge = (Join-Path $Script:DataDir 'edge-profile') }

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

# Picks the browser for the PC receiver window.
# $pref: 'auto' (Chrome if installed, otherwise Edge), 'chrome' or 'edge'.
# Returns @{ Name = 'Google Chrome'|'Microsoft Edge'; Key = 'chrome'|'edge'; Exe; Process; Profile } or $null.
function Get-ReceiverBrowser([string]$pref) {
    if (-not $pref) { $pref = 'auto' }
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
                $result[$flow] = @{ Channels = $ch; Rate = $rate; Bits = $bits; Text = "$ch channel(s), $bits bit, $rate Hz" }
                break
            }
        } catch { }
    }
    return $result
}

# Steam's virtual microphone copies sound from its "Speakers" half to its
# "Microphone" half without converting it. If the two halves are set to different
# formats, the game can hear noise or garbled sound. Prints a warning then.
# Returns $true when the formats match or could not be read.
function Show-SteamMicFormatCheck {
    $f = Get-SteamMicFormats
    $r = $f.Render
    $c = $f.Capture
    if (-not $r -or -not $c) { return $true }
    if ($r.Channels -eq $c.Channels -and $r.Rate -eq $c.Rate -and $r.Bits -eq $c.Bits) {
        Write-Ok "Steam Streaming Microphone format: $($r.Text) (both halves match)"
        return $true
    }
    Write-Warn2 'The two halves of the Steam Streaming Microphone use different audio formats:'
    Write-Host "       Speakers (Steam Streaming Microphone):   $($r.Text)"
    Write-Host "       Microphone (Steam Streaming Microphone): $($c.Text)"
    Write-Host '       If the game hears noise or garbled sound, make them the same:'
    Write-Host '       Settings -> System -> Sound -> More sound settings. On the Playback tab open'
    Write-Host '       "Speakers (Steam Streaming Microphone)" -> Properties -> Advanced, and on the Recording'
    Write-Host '       tab open "Microphone (Steam Streaming Microphone)" -> Properties -> Advanced.'
    Write-Host '       Pick the same Default Format in both (48000 Hz), then restart the game.'
    return $false
}

function Get-TailMicProcesses {
    $out = @()
    try {
        $all = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction Stop
        foreach ($p in $all) {
            $cl = [string]$p.CommandLine
            if (-not $cl) { continue }
            if ($p.Name -eq 'node.exe') {
                if ($cl.Contains($Script:ServerJs)) { $out += $p }
            } else {
                foreach ($prof in $Script:BrowserProfiles.Values) {
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

# True when this Windows user is logged in on the desktop (screen may be locked).
function Test-UserLoggedOn {
    try {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop)) {
            $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
            if ($o.User -eq $env:USERNAME) { return $true }
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

# An on-demand scheduled task that runs start.ps1 in YOUR desktop session.
# That is how TailMic is started over SSH: programs started directly from an
# SSH session are not on the desktop and cannot play audio there.
function Register-TailMicTask {
    $c = Get-HiddenStartCommand
    $action = New-ScheduledTaskAction -Execute $c.Exe -Argument $c.Args -WorkingDirectory $Script:Root
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $Script:TaskName -Action $action -Principal $principal -Settings $settings `
        -Description 'Starts TailMic (laptop microphone -> Steam Streaming Microphone). Run on demand, e.g. over SSH.' -Force -ErrorAction Stop | Out-Null
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
        if ($h -and $h.receiverWindow -and $h.outputDevice) { return $h }
        Start-Sleep -Milliseconds 500
    }
    return $h
}

# Print a short status. Returns $true if TailMic is ready to use.
function Show-TailMicStatus($h) {
    if (-not $h) {
        Write-Bad 'TailMic server: not running'
        return $false
    }
    Write-Ok 'TailMic server: running'
    if ($h.receiverWindow) { Write-Ok 'PC window: open' } else { Write-Bad 'PC window: not connected (run start again)' }
    if ($h.outputDevice) { Write-Ok "Output: $($h.outputDevice)"; [void](Show-SteamMicFormatCheck) } else { Write-Bad 'Output: Steam Streaming Microphone NOT FOUND (is Steam running?)' }
    if ($h.call) { Write-Ok "Call: $($h.call.user) ($($h.call.state))" } else { Write-Host '   --  Call: none (connect from the Mac)' }
    if ($h.serveHost) { Write-Host "   Mac address: https://$($h.serveHost):$($h.httpsPort)" }
    return [bool]($h.receiverWindow -and $h.outputDevice)
}
