# Checks the script helpers that need no Windows: syntax of every script, the
# allowed-user rules (tagged PC, device names) and the settings file writer.
# Runs in PowerShell 7 on Linux (see tests/run-tests.sh); the PC itself uses Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fails = 0
function Check([string]$name, $got, $want) {
    $g = ($got | ConvertTo-Json -Compress -Depth 5)
    $w = ($want | ConvertTo-Json -Compress -Depth 5)
    if ($g -eq $w) { Write-Host "ok    $name" } else { $script:fails++; Write-Host "FAIL  $name`n      got  $g`n      want $w" }
}

# ---- every script parses
foreach ($f in Get-ChildItem (Join-Path $root 'scripts') -Filter *.ps1) {
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
    Check "syntax: $($f.Name)" @($errs | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) @()
    # Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI: keep them plain ASCII.
    Check "ascii:  $($f.Name)" @([System.IO.File]::ReadAllBytes($f.FullName) | Where-Object { $_ -gt 127 }).Count 0
}

$env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) "tailmic-test-$PID"
. (Join-Path $root 'scripts/common.ps1')
$ErrorActionPreference = 'Stop'

# ---- `tailscale status --json` on a TAGGED PC. On a real install Tailscale reported
# the PC's own name as its "user", and setup offered that as the allowed user.
# (All names here are made up.)
$dns = 'gaming-pc.tail1234.ts.net'
$tagged = @'
{ "BackendState": "Running",
  "Self": { "DNSName": "gaming-pc.tail1234.ts.net.", "UserID": 111, "Tags": ["tag:gaming-pc"] },
  "Peer": {
    "nodekey:aa": { "DNSName": "laptop.tail1234.ts.net.", "UserID": 222 },
    "nodekey:bb": { "DNSName": "phone.tail1234.ts.net.", "UserID": 222 },
    "nodekey:cc": { "DNSName": "wake.tail1234.ts.net.", "UserID": 333, "Tags": ["tag:wake"] },
    "nodekey:dd": { "DNSName": "friend.tail9.ts.net.", "UserID": 444 }
  },
  "User": {
    "111": { "LoginName": "gaming-pc.tail1234.ts.net" },
    "222": { "LoginName": "Abc123@privaterelay.appleid.com" },
    "333": { "LoginName": "tagged-devices" },
    "444": { "LoginName": "friend@github" }
  } }
'@ | ConvertFrom-Json
$plain = '{ "Self": { "DNSName": "pc.tail1.ts.net.", "UserID": 5 }, "User": { "5": { "LoginName": "me@example.com" } } }' | ConvertFrom-Json

Check 'tagged PC: tags are seen' @(Get-TailscaleSelfTags $tagged) @('tag:gaming-pc')
Check 'untagged PC: no tags' @(Get-TailscaleSelfTags $plain).Count 0
Check 'tagged PC: its "user" is the PC name (the old bug)' (Get-TailscaleLogin $tagged) $dns
Check 'the PC name is refused as a user' ([bool](Get-LoginProblem (Get-TailscaleLogin $tagged) $dns)) $true
Check 'tagged PC: suggestions are the real users of untagged devices' @(Get-TailscalePeerLogins $tagged $dns) @('abc123@privaterelay.appleid.com', 'friend@github')
Check 'no other devices: no suggestions, no error' @(Get-TailscalePeerLogins $plain 'pc.tail1.ts.net').Count 0

Check 'login ok: e-mail' (Get-LoginProblem 'you@example.com' $dns) ''
Check 'login ok: GitHub' (Get-LoginProblem 'you@github' $dns) ''
foreach ($bad in @('', '  ', $dns, 'GAMING-PC.tail1234.ts.net.', 'other.tail9.ts.net', 'tagged-devices', 'two words@example.com')) {
    Check "login refused: '$bad'" ([bool](Get-LoginProblem $bad $dns)) $true
}

# ---- the settings file: a change keeps everything else, and one user stays a list
Save-TailMicConfig @{ allowedUsers = @('first@example.com'); serveHost = $dns; httpsPort = 8444 }
Save-TailMicConfig @{ allowedUsers = @('second@example.com') }
$saved = Get-Content -Raw $Script:ConfigFile
Check 'config: one user is written as a list' ($saved -match '"allowedUsers":\s*\[\s*"second@example.com"\s*\]') $true
$cfg = Read-Config
Check 'config: other settings are kept' @($cfg.serveHost, $cfg.httpsPort) @($dns, 8444)
Check 'config: defaults still apply' $cfg.clientPort 8470
Save-TailMicConfig @{ allowedUsers = @() }
Check 'config: no user is written as an empty list' ((Get-Content -Raw $Script:ConfigFile) -match '"allowedUsers":\s*\[\s*\]') $true
Check 'config: written without a byte-order mark' ([System.IO.File]::ReadAllBytes($Script:ConfigFile)[0]) 123

# ---- the TailMic-only browser profile: prepared for TailMic's own page and nothing else
$prof = Join-Path $Script:DataDir 'browser-chrome'
$prefs = Join-Path (Join-Path $prof 'Default') 'Preferences'
Initialize-ReceiverProfile $prof 8471
$p = Get-Content -Raw $prefs | ConvertFrom-Json
$sites = @($p.profile.content_settings.exceptions.media_stream_mic.PSObject.Properties.Name)
Check 'profile: exactly one site may use the microphone, TailMic''s own page' $sites @('http://127.0.0.1:8471,*')
Check 'profile: that site is allowed (1)' $p.profile.content_settings.exceptions.media_stream_mic.'http://127.0.0.1:8471,*'.setting 1
Check 'profile: nothing else is preset' @($p.profile.content_settings.exceptions.PSObject.Properties.Name) @('media_stream_mic')
Check 'profile: written without a byte-order mark' ([System.IO.File]::ReadAllBytes($prefs)[0]) 123
'browser state' | Set-Content (Join-Path $prof 'kept.txt')
Initialize-ReceiverProfile $prof 8471
Check 'profile: left alone when it is already prepared' (Test-Path (Join-Path $prof 'kept.txt')) $true
Initialize-ReceiverProfile $prof 9000
Check 'profile: made anew when the port changes' @((Test-Path (Join-Path $prof 'kept.txt')), ((Get-Content -Raw $prefs) -match 'http://127\.0\.0\.1:9000,\*')) @($false, $true)
$refused = $false
try { Initialize-ReceiverProfile (Join-Path ([System.IO.Path]::GetTempPath()) "not-tailmic-$PID") 8471 } catch { $refused = $true }
Check 'profile: refuses to touch a folder outside TailMic''s own' $refused $true
Check 'old (1.0) profiles are still closed by stop' (@($Script:OldBrowserProfiles | ForEach-Object { Split-Path -Leaf $_ })) @('chrome-profile', 'edge-profile')

# ---- status after an update: the running TailMic must be the files in this folder
$bin = Join-Path $env:LOCALAPPDATA 'bin'
New-Item -ItemType Directory -Path $bin | Out-Null
Set-Content -Path (Join-Path $bin 'node.exe') -Value "#!/bin/sh`necho '1.1.0 aaaaaaaaaaaa'"   # stands in for: node server.js --build
chmod +x (Join-Path $bin 'node.exe')
$env:PATH = "$bin$([System.IO.Path]::PathSeparator)$env:PATH"
Check 'installed version is read from the files' (Get-InstalledBuild) @{ Version = '1.1.0'; Id = 'aaaaaaaaaaaa' }
function Health([string]$build) {
    $h = [pscustomobject]@{ server = $true; receiverWindow = $true; outputDevice = 'Speakers (Steam Streaming Microphone)'
        allowedUsers = @('you@example.com'); call = $null; test = $false; serveHost = $dns; httpsPort = 8443; version = '1.1.0'; appDir = $Script:AppDir }
    if ($build) { $h | Add-Member -NotePropertyName build -NotePropertyValue $build }
    return $h
}
Check 'status: ready when the running copy is the files in this folder' (Show-TailMicStatus (Health 'aaaaaaaaaaaa') 6>$null) $true
Check 'status: NOT ready when an older copy is still running' (Show-TailMicStatus (Health 'bbbbbbbbbbbb') 6>$null) $false
Check 'status: NOT ready when the running copy predates this check' (Show-TailMicStatus (Health '') 6>$null) $false
$noUser = Health 'aaaaaaaaaaaa'; $noUser.allowedUsers = @()
Check 'status: NOT ready without an allowed user' (Show-TailMicStatus $noUser 6>$null) $false
Check 'status: nothing running' (Show-TailMicStatus $null 6>$null) $false
$waiting = Health 'aaaaaaaaaaaa'; $waiting.outputDevice = $null; $waiting | Add-Member -NotePropertyName needsPermission -NotePropertyValue $true
$said = (Show-TailMicStatus $waiting 6>&1 | Out-String)
Check 'status: says when the PC window waits for permission' ($said -match 'waiting for permission') $true

Remove-Item -Recurse -Force $env:LOCALAPPDATA
if ($fails) { Write-Host "$fails check(s) failed"; exit 1 }
Write-Host 'all script checks passed'
