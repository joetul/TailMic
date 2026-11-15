# TailMic

Talk into the microphone on your laptop or any other computer (Mac, Windows or Linux). This guide calls that computer the **client**. Your Windows gaming PC hears it as a normal microphone called **"Microphone (Steam Streaming Microphone)"**, which you can pick in your games.

- Works next to Moonlight + Sunshine and does **not** change them, or your default speakers.
- Uses a Chromium-based browser on the client (Chrome, Edge, Brave, ...) and Chrome **or Edge** on the PC (WebRTC, Opus codec, 48 kHz, 10 ms packets). Echo cancellation and auto gain are off so your voice isn't mangled; **noise suppression** is on by default and can be switched off on the page.
- Only works **inside your Tailscale network** and only for **your** Tailscale user. Nothing is opened to the internet or your home network.

```
Client: browser page ─(Tailscale, encrypted)──▶ PC: TailMic window ──▶ Speakers (Steam Streaming Microphone)
                                                                          │
                                         game hears ◀── Microphone (Steam Streaming Microphone)
```

---

## What you need

| On the gaming PC (Windows 11) | On the client (Mac, Windows or Linux) |
|---|---|
| Tailscale, signed in (a **tagged** device is fine) | Tailscale, signed in as **the user you allow in setup** (your own device, not a tagged one) |
| Google Chrome **or** Microsoft Edge (Edge comes with Windows) | Google Chrome, or another Chromium-based browser (see below) |
| Steam (running) | A microphone or headset |
| Node.js. Setup installs it for you | – |

**Which computer can be the client?** Any computer that runs Tailscale and a Chromium-based browser: a Mac, a Windows PC, a Linux machine or a Chromebook, laptop or desktop. Nothing in TailMic's page depends on the operating system, and its automatic tests run that page on Linux. Phones and tablets are not tested; on an iPhone or iPad every browser uses Safari's engine, not Chromium.

**Which browser on the client?** Any browser built on Chromium should work: Chrome, Edge, Brave, Vivaldi, Opera, Arc. They share the engine that TailMic's automatic tests run on, and Chrome is the one it is used with day to day, so this guide says "Chrome". Firefox and Safari are not tested. In Brave, leave **Settings → Privacy and security → WebRTC IP handling policy** on **Default**; other choices can hide the Tailscale address TailMic needs.

**Which browser on the PC?** Chrome or Edge, found automatically. Another Chromium-based browser (Brave, Vivaldi, ...) should work too if you tell TailMic where it is; see the end of Step 2.

**Tip:** use headphones on the client. Echo cancellation is off for best quality, so game sound from the client's speakers would otherwise go back into your mic.

---

## Step 1 – Tailscale settings (one time, in a web browser)

1. Open <https://login.tailscale.com/admin/dns>.
2. Under **MagicDNS**, click **Enable MagicDNS**, if it isn't on already.
3. Under **HTTPS Certificates**, click **Enable HTTPS**.

That's all. TailMic uses **Tailscale Serve**, which shares something only inside your tailnet. It does **not** use Funnel, which would make it public.

> **Access controls:** the default Tailscale policy already lets your own devices reach each other, so you don't need to change anything. If you have edited your **Access controls** file, the client must be allowed to reach the PC on **TCP 8443** (the page) and on **UDP** (the audio). On a Windows PC the audio port comes from Windows' dynamic port range, so this grant is enough:
>
> ```jsonc
> {
>   "src": ["<client>"],          // host alias, user, or group
>   "dst": ["tag:<gaming-pc>"],   // or the PC's host alias
>   "ip":  ["tcp:8443", "udp:49152-65535"]
> }
> ```
>
> - Nothing is needed in the other direction (PC → client). **Test what the game hears** uses the same connection.
> - The **PC** may be a tagged device. The **client** must be an untagged device of the allowed user: TailMic refuses tagged callers, because they have no user.

---

## Step 2 – Set up the gaming PC (one time)

1. Make sure **Steam is running** and **Tailscale is connected**.
2. Download TailMic. On the PC, open **PowerShell** (Start menu → type `powershell` → Enter) and paste this. It also works over SSH.

   ```powershell
   $dir = "$HOME\TailMic"
   Invoke-WebRequest -UseBasicParsing https://github.com/joetul/TailMic/archive/refs/heads/main.zip -OutFile "$env:TEMP\TailMic.zip"
   Remove-Item "$env:TEMP\TailMic-new" -Recurse -Force -ErrorAction SilentlyContinue
   Expand-Archive "$env:TEMP\TailMic.zip" "$env:TEMP\TailMic-new"
   New-Item -ItemType Directory $dir -Force | Out-Null
   Copy-Item "$env:TEMP\TailMic-new\TailMic-main\*" $dir -Recurse -Force
   ```

   TailMic is now in the folder **`TailMic` inside your user folder** (`C:\Users\you\TailMic`), and every command in this guide uses that place. It is also the safe place: TailMic's files run as you, and other Windows accounts on the PC can't change files in your user folder.
3. At the PC's desktop, open **File Explorer → your user folder → `TailMic`**, double-click **`Setup-TailMic.cmd`**, and answer the questions:
   - **Allowed user:** the Tailscale login of the client's user. Setup suggests it; press **Enter** to accept. If the PC is a **tagged** device, setup suggests the users of the other devices on your tailnet instead. If it finds none, or the login is hard to type through Moonlight, press **Enter** to skip and set it afterwards from the client with [`TailMic.cmd set-user`](#start-and-stop-over-ssh-without-touching-the-pc).
   - **Node.js:** if it's missing, press **Enter** to install it. Windows may ask for permission.
   - **Steam Streaming Microphone:** setup checks that the device exists and that its two halves use the same audio format. A freshly installed device often doesn't; setup then shows an error with the exact format to pick. If the device is missing, or for the format fix, see [Troubleshooting](#troubleshooting).
   - **Tailscale Serve:** the first time, Tailscale may print a link. Open it, click **Enable**, and go back to the setup window.
   - A small **"TailMic (PC)"** window opens minimized. You never need to touch it, and there is no permission prompt to click. It only plays your voice into Steam's device. It listens on the PC only while you run [**Test what the game hears**](#test-what-the-game-hears) from the client, and nothing is ever saved.
   - Setup also creates a Windows scheduled task called **TailMic**, so you can start TailMic over SSH (see below).
   - **Start with Windows?** Press **Enter** for yes (recommended).

   Run Setup at the PC's desktop (through Moonlight is fine), not over SSH, because installing Node.js may show a Windows permission prompt. Setup is safe to run again at any time: it keeps your settings and only fixes what is missing.
4. At the end, setup shows the client address, something like
   **`https://gaming-pc.tail1234.ts.net:8443`**, and copies it to the clipboard. Send it to the client (email, notes, etc.).

Windows Firewall: Tailscale's own rule (`Tailscale-In`) normally already allows traffic to the PC's Tailscale addresses, so TailMic needs no firewall rule. If Windows Firewall does ask about the browser, choose **Allow**. Private networks are enough.

**Which browser does the PC use?** Chrome if it's installed, otherwise Edge. Either way it runs in its own TailMic-only profile, so your normal browser (bookmarks, sign-in, tabs) isn't touched. To choose yourself, open `%LOCALAPPDATA%\TailMic\config.json` in Notepad, add one of these lines after the first `{`, save, and run `TailMic.cmd stop` then `TailMic.cmd start`:

| Line to add | The PC window uses |
|---|---|
| `"receiverBrowser": "edge",` | Edge, even if Chrome is installed |
| `"receiverBrowser": "chrome",` | Chrome |
| `"receiverBrowser": "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",` | The browser at that path. It must be built on Chromium (Brave, Vivaldi, Opera, ...). Write the path with forward slashes `/`. |
| `"receiverBrowser": "auto",` (or no line) | Chrome if installed, otherwise Edge |

TailMic's automatic tests run on Chromium, the engine inside Chrome and Edge. Other Chromium-based browsers take the same start-up switches and the same prepared profile, so they should work, but they are not tested. If `TailMic.cmd status` then says the PC window is waiting for permission, click **Allow** in the TailMic window once.

---

## Step 3 – Every time you play

**On the PC:** nothing to do if you chose "Start with Windows". Otherwise double-click **`Start-TailMic.cmd`**, or run **`TailMic.cmd start`** (also [over SSH](#start-and-stop-over-ssh-without-touching-the-pc)). The TailMic window opens minimized; you never need to look at it.

**On the client:**
1. Open the address from Step 2 in **Chrome** (or your Chromium-based browser), and bookmark it.
2. Pick your microphone and click **Connect**.
   **Noise suppression** (on by default) filters fans, hum and room noise. Turn it off for the purest sound in a quiet room. You can switch it, or change the microphone, while connected, and the page remembers your choice.
3. The first time, allow the microphone. On a Mac, also allow the browser under **System Settings → Privacy & Security → Microphone**.
4. The status turns green: **Connected**. The meter moves when you talk. **Mute** mutes you, and you stay muted if the call drops and reconnects on its own. **Disconnect** stops; the next call starts unmuted.

If the connection drops (Wi-Fi, PC restart), the client **beeps for a few seconds** so you notice it while you're in Moonlight, and the page reconnects on its own. A short chime tells you it's back. You hear the same beeps if the PC stops playing your microphone (the TailMic window on the PC was closed, or Steam's device disappeared). Untick **Sound alerts** on the page to turn this off.

---

## Step 4 – Choose the microphone in the game

In the game's audio / voice chat settings (usually under **Settings → Audio** or **Voice**), set the input device to:

> **Microphone (Steam Streaming Microphone)**

If a game has no microphone picker, it uses the Windows default. Set it on the PC under **Settings → System → Sound → Input → choose "Microphone (Steam Streaming Microphone)"**. For Steam voice chat, use **Steam → Settings → Voice → Voice Input Device**.

**Check it works:** on the client page, click **Tone check** (see the next section). Or on the PC, in **Settings → System → Sound → Input**, the level bar for *Microphone (Steam Streaming Microphone)* should move while you talk.

Start TailMic **before** launching the game, because some games only look for microphones at startup.

---

## Test what the game hears

While connected, the client page can let you hear, **on the client**, exactly what a game gets from *Microphone (Steam Streaming Microphone)*. Use headphones.

| Button | What it does |
|---|---|
| **Tone check** | Sends a 1000 Hz test tone instead of your microphone for about 3 seconds (the game hears the beep), and measures the pitch that comes back. It tells you in plain words if speed and pitch are right, and if not, what is wrong and how to fix it. About 500 Hz back means half speed (the two halves of the Steam device have a different number of channels); about 920 Hz means their sample rates differ; silence means nothing arrives. |
| **Record 5 s and play back** | Records 5 seconds of what the game hears while you talk, then plays it to you. |
| **Listen live** | Plays what the game hears continuously, a moment late, until you click **Stop listening**. Without headphones this echoes. |

Run **Tone check** once after setup, and whenever people say you sound strange.

The audio comes back over the same connection as your microphone: no extra port, and only over Tailscale. This is the only time TailMic listens on the PC:

- It starts when you click one of the buttons, and stops when the test ends or when you disconnect. The PC also stops by itself 30 seconds after the client last asked, so it can't be left listening if the client goes away. (**Listen live** keeps asking for as long as you leave it on.)
- It listens to *Microphone (Steam Streaming Microphone)* only, found by name. It refuses any other microphone.
- Nothing is saved on the PC. The 5-second recording is kept in the client page's memory and is gone after it has played.
- Only the allowed Tailscale user can start a test, and only during their own call.
- While a test runs, Windows shows its **microphone-in-use** indicator for the TailMic browser, the TailMic window shows **Game-hears test: ON**, and `TailMic.cmd status` shows it too.

---

## Start and stop over SSH (without touching the PC)

If the PC runs the Windows **OpenSSH Server** (Settings → System → Optional features), you can control TailMic from a terminal on the client over Tailscale. Replace `you` and `gaming-pc` with your Windows user and the PC's Tailscale name:

```
ssh you@gaming-pc ".\TailMic\TailMic.cmd start"
ssh you@gaming-pc ".\TailMic\TailMic.cmd status"
ssh you@gaming-pc ".\TailMic\TailMic.cmd stop"
ssh you@gaming-pc ".\TailMic\TailMic.cmd set-user you@example.com"
ssh you@gaming-pc ".\TailMic\TailMic.cmd update"
```

An SSH session starts in your user folder, which is where TailMic is, so `.\TailMic\TailMic.cmd` is all the path you need. (If you put TailMic somewhere else, use its full path, for example `C:\TailMic\TailMic.cmd`.)

`start` waits until TailMic is ready, then prints something like:

```
   OK  TailMic server: running (version 1.2.1)
   OK  PC window: open
   OK  Output: Speakers (Steam Streaming Microphone)
   OK  Steam Streaming Microphone format: 2 channel, 32 bit, 48000 Hz (both halves match)
   OK  Allowed user: you@example.com
   --  Call: none (connect from the client)
   Client address: https://gaming-pc.tail1234.ts.net:8443
```

- You must be **logged in to Windows** on the PC (you are, if Moonlight shows your desktop; a locked screen is fine). Programs started straight from an SSH session can't reach the desktop or play audio there, so `start` runs TailMic in your desktop session through the **TailMic** scheduled task that Setup created.
- `set-user` changes the allowed Tailscale user without asking anything, so you can paste the login from the client instead of typing it through Moonlight. It restarts TailMic if it's running and then shows the status.
- `update` gets the latest TailMic from GitHub and restarts it; see [Update TailMic](#update-tailmic).
- `stop` asks the TailMic window and server to close cleanly, and force-closes them only if they're still running after 8 seconds.
- Start TailMic **before** launching the game, because some games only look for microphones at startup.

## Stop, autostart, uninstall

| To... | Do this on the PC |
|---|---|
| Stop TailMic now | `TailMic.cmd stop` (also over SSH), or double-click `Stop-TailMic.cmd` |
| Check if it's ready | `TailMic.cmd status` |
| Start with Windows on / off | `Autostart-On.cmd` / `Autostart-Off.cmd` |
| Change the allowed user | `TailMic.cmd set-user you@example.com` (also over SSH), or run `Setup-TailMic.cmd` again |
| Update to the latest version | Double-click `Update-TailMic.cmd`, or `TailMic.cmd update` (also over SSH). See [Update TailMic](#update-tailmic) |
| Uninstall | `Stop-TailMic.cmd`, `Autostart-Off.cmd`, then in a terminal: `tailscale serve --https=8443 off` and `schtasks /delete /tn TailMic /f`. Delete the `TailMic` folder in your user folder, and `%LOCALAPPDATA%\TailMic`. |

---

## Update TailMic

- **At the PC:** double-click **`Update-TailMic.cmd`** in the TailMic folder.
- **From the client:** `ssh you@gaming-pc ".\TailMic\TailMic.cmd update"`

Both do the same: download the latest TailMic from <https://github.com/joetul/TailMic> over the files in the TailMic folder, restart TailMic if it was running, and show the status. If you already have the latest version, it says so and changes nothing.

Your settings (allowed user, ports) are stored in `%LOCALAPPDATA%\TailMic`, not in the TailMic folder, so they are kept. Nothing needs updating on the client: it gets its page from the PC.

- If `status` shows a problem after an update, run `Setup-TailMic.cmd` again at the PC's desktop and press **Enter** at every question. It keeps your allowed user and your "Start with Windows" choice, and fixes what is missing.
- If you installed TailMic with `git clone`, use `git pull` instead, then `TailMic.cmd stop` and `TailMic.cmd start`.

<details>
<summary><b>No <code>Update-TailMic.cmd</code> in your TailMic folder?</b> (installed before version 1.2: do this once)</summary>

On the PC, open **PowerShell** and paste this, or connect with `ssh you@gaming-pc` and paste it there. (If the SSH prompt starts with `C:\...>` without `PS` in front, type `powershell` first.) If TailMic is in another folder, change the first line to it, for example `$dir = "C:\TailMic"`.

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

</details>

**Check that the PC really runs the new version:** run `TailMic.cmd status` (also over SSH).

- The first line shows the version that is running, for example `TailMic server: running (version 1.2.1)`. The newest version number is in [`app/package.json`](https://github.com/joetul/TailMic/blob/main/app/package.json) on GitHub.
- If it says **"running, but NOT the files in this folder"**, the files were replaced but an older TailMic is still running (or TailMic runs from another folder). Run `TailMic.cmd stop` and then `TailMic.cmd start`. `status` compares the running program with the files on disk, so it notices this even when the version number didn't change.
- On the client, **reload the TailMic page** if it was open during the update.

---

## Troubleshooting

| You see | What to do |
|---|---|
| Client: **"TailMic is not running on the PC"** | Double-click `Start-TailMic.cmd` on the PC, or run `TailMic.cmd start` (also over SSH). |
| `status`: **"running, but NOT the files in this folder"** | TailMic was updated but not restarted, or it runs from another folder. Run `TailMic.cmd stop`, then `TailMic.cmd start`. See [Update TailMic](#update-tailmic). |
| A button or message described here is **missing** on the client page | The PC runs an older TailMic. [Update it](#update-tailmic), then reload the page. |
| **"Steam Streaming Microphone not found"** | Start Steam on the PC. If it still isn't there, the device was never installed. *Speakers (Steam Streaming Speakers)* is a **different** device (Sunshine can add it) and doesn't count: you need *Speakers (Steam Streaming Microphone)* and *Microphone (Steam Streaming Microphone)*. To install them: **1.** on the PC, turn on **Steam → Settings → Remote Play → Enable Remote Play**; **2.** install the free **Steam Link** app on the client and connect to the PC once, entering the PIN it shows on the PC; **3.** close Steam Link right away, and keep using Moonlight. Then run `Setup-TailMic.cmd` again and check the format (the row about a slow, deep voice below): a freshly installed device usually needs that fix once. |
| Client: **"The browser on this computer found no Tailscale address"** | Tailscale isn't connected on the client. Connect it and click Connect again. In Brave, also check that **WebRTC IP handling policy** is on **Default** (Settings → Privacy and security). |
| PC window: **"No Tailscale address"** | Tailscale isn't connected on the PC. |
| Page won't open / "site can't be reached" | Check that both devices are connected in Tailscale and that MagicDNS and HTTPS are enabled (Step 1). Then run Setup again on the PC. |
| **"Tailscale user ... is not allowed"** | The client is signed in as a different Tailscale user than the allowed one. Sign in as that user, or allow the one in the message: `TailMic.cmd set-user <that login>` on the PC (also over SSH). |
| `status`: **"Allowed user: NONE"** | No allowed user was set during Setup. Run `TailMic.cmd set-user <your Tailscale login>` on the PC (also over SSH). |
| Connected, but the game hears nothing | Choose **Microphone (Steam Streaming Microphone)** in the game (Step 4). Restart the game after starting TailMic. Check the level bar in Windows Sound settings. |
| PC window: **"Open in another window"** | TailMic was started twice. The newer window is in use; `TailMic.cmd stop` closes both. |
| `status`: **"PC window: open, but it is waiting for permission"** | The TailMic window asks to use audio devices. At the PC's desktop (through Moonlight is fine), click **Allow** in the TailMic window; it is needed once. Normally TailMic sets this permission up by itself. |
| `status`: **"PC window: not connected"** | Run `TailMic.cmd start` again. Over SSH this needs you to be logged in to Windows on the PC. |
| `start` over SSH: **"Nobody is logged in to Windows"** | Log in on the PC (for example through Moonlight), then run `start` again. |
| `start` over SSH: **"Could not create the TailMic scheduled task"** | Run `Setup-TailMic.cmd` once at the PC's desktop (through Moonlight is fine). It creates the task, and `start` then only has to run it. |
| The game hears your voice **slow, deep or "dark"**, or **noise or garbled sound** | The two halves of the Steam device use different audio formats. That always breaks the sound, and a freshly installed device often starts out this way. `TailMic.cmd status` reports it as an error and prints the exact format to pick; **Tone check** on the client page finds it too. On the PC open **Settings → System → Sound → More sound settings → Recording** tab → *Microphone (Steam Streaming Microphone)* → **Properties → Advanced**, and set **Default Format** to exactly what `status` prints for the Speakers half, for example **"2 channel, 32 bit, 48000 Hz"**. **Channels, bits and Hz must all match**; the same Hz alone is not enough. (2 channels played into 1 channel gives half speed, an octave lower. 48000 Hz into 44100 Hz is about 8% too slow, with crackle.) Change the Microphone half: the Playback tab doesn't show the channel count of the Speakers half. Then run `TailMic.cmd stop`, `TailMic.cmd start` and `TailMic.cmd status`, and restart the game. |
| Test: **"The PC cannot find Microphone (Steam Streaming Microphone)"** | Start Steam on the PC. On the PC, under **Settings → System → Sound → Input**, check that the device exists and is not disabled. |
| Echo / people hear the game | Use headphones on the client. |
| Game sound on the client turns **muffled** when you connect | You're using a Bluetooth headset. Bluetooth drops to phone-call quality while its microphone is in use. Use a wired or USB headset, a 2.4 GHz wireless one, or a separate microphone. |
| Logs | `%LOCALAPPDATA%\TailMic\logs` on the PC |

---

## How it stays secure

- **Tailnet only.** The PC page is published with `tailscale serve` (HTTPS with a real certificate), which is reachable only by devices in your tailnet. TailMic's own server listens only on `127.0.0.1` (this PC), so it isn't reachable from your home network or the internet. Funnel is never turned on; setup refuses to continue if it finds Funnel on TailMic's port.
- **Only your user.** Tailscale Serve adds the caller's verified Tailscale login to every request, and removes any copy of it a client tries to send. TailMic accepts only the login saved during setup. Requests from other users or tagged devices are refused.
- **Audio only over Tailscale.** No STUN/TURN servers are used. Before the two browsers connect, the server and both browsers remove every non-Tailscale network address from what each side is **told** about the other, so the client only learns the PC's Tailscale address and vice versa. The PC's side is pinned to the PC's **exact** Tailscale IPs (read with `tailscale ip`); the client's side must be in Tailscale's address ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Each browser still knows its own LAN addresses internally, but it has nowhere else to send audio. Once connected, both sides check the actual route against the same rules and hang up if it fails. The audio is also end-to-end encrypted by WebRTC (DTLS-SRTP).
- **Other websites can't interfere.** The PC side only accepts requests from TailMic's own window, so a website you open in a browser on the PC can't open it or take it over. On the client, other websites can't start or stop a TailMic connection.
- **The PC listens only during a test.** In normal use TailMic only plays sound on the PC. While you run **Test what the game hears**, the TailMic window listens to *Microphone (Steam Streaming Microphone)*, and to no other microphone, and sends that sound to the client over the same Tailscale-only connection. It stops with the test or the call, and nothing is written to disk.
- **One site, one permission.** The TailMic window runs in its own browser profile. Start-TailMic prepares that profile so that exactly one site, TailMic's own page on this PC, may use audio devices without asking. The page needs that to see the names of the audio devices (to find Steam's), and for the test above; this way it works with nobody at the PC. No other site gets anything, even if it were opened in that profile, and TailMic does not open the PC's own microphone. (Only if the prepared permission is missing does the window ask once; clicking Allow then opens the default microphone for an instant.)
- **Nothing extra on your PC.** No npm packages are needed, the PC uses a separate TailMic-only browser profile (your normal browser isn't touched), and Windows default audio devices aren't changed. TailMic never changes a device's audio format either; if the Steam device needs the format fix, you do it yourself in Windows.

### What TailMic trusts

TailMic protects the connection between the client and your PC from everyone else. It does not protect you from these, so keep them yours:

- **The gaming PC, and everything that runs on it.** Programs on the PC, and other Windows accounts on it, can reach TailMic's two local ports, and can already record the Steam microphone directly. Also, the page the client opens comes from the PC, and you allowed that page to use the client's microphone. So use TailMic on a PC that is yours; if other people log in to it, keep the TailMic folder inside your user folder, where Step 2 puts it.
- **Your Tailscale account.** Whoever can sign in as the allowed user can connect. Turn on two-factor authentication at your login provider.
- **The download.** Installing and updating (`Update-TailMic.cmd`) fetch whatever is in the GitHub repository at that moment, over HTTPS, and run it.

### What is stored and sent

- **No audio is ever stored**, on either side. The 5-second test recording lives in the client page's memory until it has played.
- **Nothing is sent to anyone else.** The pages load no fonts, scripts or anything else from the internet, there is no analytics, and the audio goes directly between your two browsers over Tailscale.
- **On the PC**, in `%LOCALAPPDATA%\TailMic`: the settings (the allowed login, the PC's Tailscale name, ports), the TailMic-only browser profile, and logs. The logs record when TailMic started, who connected or was refused (Tailscale login), the Tailscale addresses used, and when a test started and stopped. Logs older than 14 days are deleted when TailMic starts.
- **On the client**, in the browser's storage for the TailMic page: which microphone you picked and the two checkboxes.

### What it costs on the PC

Two things run on the PC, and nothing else stays behind: a small Node.js program (roughly 60 MB of memory) and one minimized browser window with a single page. Both sit idle until you connect; a call is one audio stream of at most about 130 kbit/s.

- **It doesn't grow.** Every call's connection, microphone and timers are closed when it ends, and the tests check that after many calls in a row.
- **The browser window is kept quiet.** It is started with the browser's own background work switched off (component downloads, update and safety-list checks, reports), because it only ever shows TailMic's page.
- **Little disk use.** Logs are a few lines per call and are deleted after 14 days.

The browser window is the larger part (like any open browser window, a few hundred MB). To see the real numbers on your PC, open Task Manager and look for `node.exe` and the browser entries that started with TailMic.

## Ports used

| Port | Where | What |
|---|---|---|
| 8443 (HTTPS) | Tailscale Serve, tailnet only | the client page |
| 8470 | 127.0.0.1 only | TailMic server, behind Tailscale Serve |
| 8471 | 127.0.0.1 only | the PC receiver window |
| UDP, chosen by the browsers (on a Windows PC: 49152–65535) | Tailscale addresses only | the audio, directly between the two browsers |

To change the first three, add for example `"httpsPort": 8444` to `%LOCALAPPDATA%\TailMic\config.json` and run Setup again.

---

## For developers

- `app/server.js`: zero-dependency Node.js server (signaling + static files). `app/web/sdp.js` holds the address filter and Opus tuning, shared by the server and both pages.
- `app/web/tone.js`: the tone check's pitch measurement and verdicts.
- `scripts/*.ps1`: Windows PowerShell 5.1 scripts behind the `.cmd` files. `scripts/receiver-preferences.json` is what `start.ps1` writes into the TailMic-only browser profile: the permission for TailMic's own page.
- `scripts/update.ps1` is the update. `Update-TailMic.cmd` and the `update` part of `TailMic.cmd` call it in a single line, on purpose: the update replaces those files while they run, and `cmd.exe` would otherwise go on reading commands from the new file.
- `app/package.json` holds the version number that `TailMic.cmd status` shows. Raise it when you publish a change, so users can tell which version they run.
- Tests (Docker only): `sh tests/run-tests.sh`. They cover:
  - unit tests (Node 22) for address filtering, SDP tuning, user and identity checks, request limits, the tone check's verdicts, who may start a test, and the version fingerprint;
  - script checks in PowerShell 7 on Linux: every script parses, the allowed-user rules (a tagged PC, device names), the settings file, and that `status` notices an outdated running copy, the prepared browser profile, and a complete update from a zip made on the spot (old, missing and unrelated files, a second run, a download that is not TailMic);
  - an end-to-end test with two real headless Chromium browsers and a fake microphone. It checks that audio arrives, the codec is Opus mono at 100 packets/s, the processing settings are applied (including switching noise suppression on mid-call), and audio plays only to the configured device;
  - **Test what the game hears**, with a stand-in for Steam's device: audio comes back, the tone check reports OK, half speed (channel mismatch), a sample-rate mismatch and silence correctly, the PC listens only during a test, and it refuses any other microphone;
  - the messages on both pages keep up with what is true: a note about a finished call or test goes away again, Mute survives a reconnect, a PC that stopped playing the microphone stays a warning, and a PC window that was replaced or lost its server does not say "Ready";
  - the PC window in a browser profile prepared exactly as `start.ps1` does it, under the page's real security policy: it gets its devices without a prompt and without opening a microphone, other sites in that profile get nothing, and without the permission `status` says so;
  - resources: 25 calls in a row leave no connection, microphone or audio context open on either side;
  - a check that the Tailscale-only rule refuses a non-Tailscale network, and that a wrong user is refused.
- **Not tested automatically** (needs a real Windows PC with Tailscale and Steam): the Windows audio device, Tailscale Serve, the scheduled task (also over SSH), and the Steam device format check. These steps are small and print clear messages if something is wrong.
