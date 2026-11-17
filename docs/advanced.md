# Setup details and options

This page adds detail to the [README](../README.md). You don't need it for a normal install.

## Which computer and browser

**The client** can be any computer that runs Tailscale and a Chromium-based browser: a Mac, a Windows PC, a Linux machine or a Chromebook, laptop or desktop. Nothing in TailMic's page depends on the operating system, and its automatic tests run that page on Linux. Phones and tablets are not tested; on an iPhone or iPad every browser uses Safari's engine, not Chromium.

**The browser on the client** can be any browser built on Chromium: Chrome, Edge, Brave, Vivaldi, Opera, Arc. They share the engine that TailMic's automatic tests run on, and Chrome is the one it is used with day to day. Firefox and Safari are not tested. In Brave, leave **Settings → Privacy and security → WebRTC IP handling policy** on **Default**; other choices can hide the Tailscale address TailMic needs.

**The browser on the PC** is Chrome if it's installed, otherwise Edge. Either way it runs in its own TailMic-only profile, so your normal browser (bookmarks, sign-in, tabs) isn't touched. To choose yourself, open `%LOCALAPPDATA%\TailMic\config.json` in Notepad, add one of these lines after the first `{`, save, and run `TailMic.cmd stop` then `TailMic.cmd start`:

| Line to add | The PC window uses |
|---|---|
| `"receiverBrowser": "edge",` | Edge, even if Chrome is installed |
| `"receiverBrowser": "chrome",` | Chrome |
| `"receiverBrowser": "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",` | The browser at that path. It must be built on Chromium (Brave, Vivaldi, Opera, ...). Write the path with forward slashes `/`. |
| `"receiverBrowser": "auto",` (or no line) | Chrome if installed, otherwise Edge |

Other Chromium-based browsers take the same start-up switches and the same prepared profile as Chrome and Edge, so they should work, but they are not tested. If `TailMic.cmd status` then says the PC window is waiting for permission, click **Allow** in the TailMic window once.

## Tailscale

TailMic uses **Tailscale Serve**, which shares something only inside your tailnet. It does not use Funnel, which would make it public. Serve needs **MagicDNS** and **HTTPS Certificates**, both enabled at <https://login.tailscale.com/admin/dns>.

**Access controls.** The default Tailscale policy already lets your own devices reach each other, so you don't need to change anything. If you have edited your **Access controls** file, the client must be allowed to reach the PC on **TCP 8443** (the page) and on **UDP** (the audio). On a Windows PC the audio port comes from Windows' dynamic port range, so this grant is enough:

```jsonc
{
  "src": ["<client>"],          // host alias, user, or group
  "dst": ["tag:<gaming-pc>"],   // or the PC's host alias
  "ip":  ["tcp:8443", "udp:49152-65535"]
}
```

Nothing is needed in the other direction (PC → client). **Test what the game hears** uses the same connection.

**Tagged devices.** The PC may be a tagged device. The client must be an untagged device of the allowed user: TailMic refuses tagged callers, because they have no user.

**Windows Firewall.** Tailscale's own rule (`Tailscale-In`) normally already allows traffic to the PC's Tailscale addresses, so TailMic needs no firewall rule. If Windows Firewall does ask about the browser, choose **Allow**. Private networks are enough.

## What setup asks and does

- **Allowed user:** the Tailscale login of the client's user. Setup suggests it; press **Enter** to accept. If the PC is a tagged device, setup suggests the users of the other devices on your tailnet instead. If it finds none, or the login is hard to type through Moonlight, press **Enter** to skip and set it afterwards from the client with `TailMic.cmd set-user`.
- **Node.js:** if it's missing, press **Enter** to install it. Windows may ask for permission, which is why setup runs at the PC's desktop and not over SSH.
- **Steam Streaming Microphone:** setup checks that the device exists and that its two halves use the same audio format. If the device is missing, setup shows the steps to install it. A freshly installed device often has the wrong format; setup then shows an error with the exact format to pick. Both are described under [Steam's microphone device](../README.md#steams-microphone-device) in the README.
- **Tailscale Serve:** the first time, Tailscale may print a link. Open it, click **Enable**, and go back to the setup window.
- **The TailMic window:** a small "TailMic (PC)" window opens minimized. You never need to touch it, and there is no permission prompt to click.
- **A scheduled task** called **TailMic** is created, so that TailMic can be started over SSH.
- **Start with Windows?** Press **Enter** for yes (recommended).

Setup keeps your settings when you run it again, and only fixes what is missing.

The install folder, `TailMic` inside your user folder, is also the safe place: TailMic's files run as you, and other Windows accounts on the PC can't change files in your user folder.

## Over SSH

The PC needs the Windows **OpenSSH Server** (Settings → System → Optional features). An SSH session starts in your user folder, which is where TailMic is, so `.\TailMic\TailMic.cmd` is all the path you need. If you put TailMic somewhere else, use its full path, for example `C:\TailMic\TailMic.cmd`.

```
ssh you@gaming-pc ".\TailMic\TailMic.cmd start"
ssh you@gaming-pc ".\TailMic\TailMic.cmd status"
ssh you@gaming-pc ".\TailMic\TailMic.cmd stop"
ssh you@gaming-pc ".\TailMic\TailMic.cmd set-user you@example.com"
ssh you@gaming-pc ".\TailMic\TailMic.cmd update"
```

`start` waits until TailMic is ready, then prints something like:

```
   OK  TailMic server: running (version 1.2.3)
   OK  PC window: open
   OK  Output: Speakers (Steam Streaming Microphone)
   OK  Steam Streaming Microphone format: 2 channel, 32 bit, 48000 Hz (both halves match)
   OK  Allowed user: you@example.com
   --  Call: none (connect from the client)
   Client address: https://gaming-pc.tail1234.ts.net:8443
```

- You must be **logged in to Windows** on the PC (you are, if Moonlight shows your desktop; a locked screen is fine). Programs started straight from an SSH session can't reach the desktop or play audio there, so `start` runs TailMic in your desktop session through the **TailMic** scheduled task that setup created.
- `set-user` changes the allowed Tailscale user without asking anything, so you can paste the login from the client instead of typing it through Moonlight. It restarts TailMic if it's running and then shows the status.
- `stop` asks the TailMic window and server to close cleanly, and force-closes them only if they're still running after 8 seconds.

## Update

`Update-TailMic.cmd` and `TailMic.cmd update` do the same: download the latest TailMic from <https://github.com/joetul/TailMic> over the files in the TailMic folder, restart TailMic if it was running, and show the status. If you already have the latest version, it says so and changes nothing.

Your settings (allowed user, ports) are stored in `%LOCALAPPDATA%\TailMic`, not in the TailMic folder, so they are kept. Nothing needs updating on the client: it gets its page from the PC.

- If `status` shows a problem after an update, run `Setup-TailMic.cmd` again at the PC's desktop and press **Enter** at every question.
- If you installed TailMic with `git clone`, use `git pull` instead, then `TailMic.cmd stop` and `TailMic.cmd start`.

**Check that the PC really runs the new version:** double-click `Status-TailMic.cmd`, or run `TailMic.cmd status`.

- The first line shows the version that is running, for example `TailMic server: running (version 1.2.3)`. The newest version number is in [`app/package.json`](https://github.com/joetul/TailMic/blob/main/app/package.json) on GitHub.
- If it says **"running, but NOT the files in this folder"**, the files were replaced but an older TailMic is still running, or TailMic runs from another folder. Run `TailMic.cmd stop` and then `TailMic.cmd start`. `status` compares the running program with the files on disk, so it notices this even when the version number didn't change.

**No `Update-TailMic.cmd` in your TailMic folder?** You installed before version 1.2. Do this once: on the PC, open PowerShell and paste the block below, or connect with `ssh you@gaming-pc` and paste it there. (If the SSH prompt starts with `C:\...>` without `PS` in front, type `powershell` first.) If TailMic is in another folder, change the first line to it, for example `$dir = "C:\TailMic"`.

```powershell
$dir = "$HOME\TailMic"
& "$dir\TailMic.cmd" stop
Invoke-WebRequest -UseBasicParsing https://github.com/joetul/TailMic/archive/refs/heads/main.zip -OutFile "$env:TEMP\TailMic.zip"
Remove-Item "$env:TEMP\TailMic-new" -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive "$env:TEMP\TailMic.zip" "$env:TEMP\TailMic-new"
Copy-Item "$env:TEMP\TailMic-new\TailMic-main\*" $dir -Recurse -Force
& "$dir\TailMic.cmd" start
```

From then on, use `Update-TailMic.cmd`.

## Ports

| Port | Where | What |
|---|---|---|
| 8443 (HTTPS) | Tailscale Serve, tailnet only | the client page |
| 8470 | 127.0.0.1 only | TailMic server, behind Tailscale Serve |
| 8471 | 127.0.0.1 only | the PC receiver window |
| UDP, chosen by the browsers (on a Windows PC: 49152–65535) | Tailscale addresses only | the audio, directly between the two browsers |

To change the first three, add for example `"httpsPort": 8444` to `%LOCALAPPDATA%\TailMic\config.json` and run setup again.

## Uninstall

1. Double-click `Stop-TailMic.cmd`, then `Autostart-Off.cmd`.
2. In a terminal on the PC, run `tailscale serve --https=8443 off` and `schtasks /delete /tn TailMic /f`.
3. Delete the `TailMic` folder in your user folder, and `%LOCALAPPDATA%\TailMic`.
