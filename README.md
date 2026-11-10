# TailMic

Talk into the microphone on your laptop (Mac or Windows). Your Windows gaming PC hears it as a normal microphone called **"Microphone (Steam Streaming Microphone)"**, which you can pick in your games.

- Works next to Moonlight + Sunshine and does **not** change them, or your default speakers.
- Uses Chrome on the laptop and Chrome **or Edge** on the PC (WebRTC, Opus codec, 48 kHz, 10 ms packets). Echo cancellation and auto gain are off so your voice isn't mangled; **noise suppression** is on by default and can be switched off on the page.
- Only works **inside your Tailscale network** and only for **your** Tailscale user. Nothing is opened to the internet or your home network.

```
Laptop: Chrome page ──(Tailscale, encrypted)──▶ PC: TailMic window ──▶ Speakers (Steam Streaming Microphone)
                                                                          │
                                         game hears ◀── Microphone (Steam Streaming Microphone)
```

---

## What you need

| On the gaming PC (Windows 11) | On the laptop (Mac or Windows) |
|---|---|
| Tailscale, signed in | Tailscale, signed in **with the same account** |
| Google Chrome **or** Microsoft Edge (Edge comes with Windows) | Google Chrome |
| Steam (running) | A microphone or headset |
| Node.js. Setup installs it for you | – |

**Tip:** use headphones on the laptop. Echo cancellation is off for best quality, so game sound from your laptop speakers would otherwise go back into your mic.

---

## Step 1 – Tailscale settings (one time, in a web browser)

1. Open <https://login.tailscale.com/admin/dns>.
2. Under **MagicDNS**, click **Enable MagicDNS**, if it isn't on already.
3. Under **HTTPS Certificates**, click **Enable HTTPS**.

That's all. TailMic uses **Tailscale Serve**, which shares something only inside your tailnet. It does **not** use Funnel, which would make it public.

> **Access controls:** the default Tailscale policy already lets your own devices reach each other, so you don't need to change anything. If you have edited your **Access controls** (ACL) file, your laptop must be allowed to reach the PC on **TCP 8443** and on **UDP** (any port; the audio uses it).

---

## Step 2 – Set up the gaming PC (one time)

1. Make sure **Steam is running** and **Tailscale is connected**.
2. Download TailMic to the PC: on its GitHub page, click **Code → Download ZIP**. **Right-click the zip → Properties → tick "Unblock" → OK**, then extract it to a folder you keep, for example `C:\TailMic`. Make sure `Setup-TailMic.cmd` is directly inside that folder, not one level deeper.
3. Double-click **`Setup-TailMic.cmd`** and answer the questions:
   - **Allowed user:** it shows your Tailscale login. Press **Enter** to accept it.
   - **Node.js:** if it's missing, press **Enter** to install it. Windows may ask for permission.
   - **Steam Streaming Microphone:** setup checks that the device exists and that its two halves use the same audio format. If the device is missing, see [Troubleshooting](#troubleshooting).
   - **Tailscale Serve:** the first time, Tailscale may print a link. Open it, click **Enable**, and go back to the setup window.
   - A small **"TailMic (PC)"** window opens minimized. You never need to touch it: there is no permission prompt to click, and nothing on the PC is recorded.
   - Setup also creates a Windows scheduled task called **TailMic**, so you can start TailMic over SSH (see below).

Run Setup once at the PC's desktop (through Moonlight is fine), because installing Node.js may show a Windows permission prompt.
   - **Start with Windows?** Press **Enter** for yes (recommended).
4. At the end, setup shows your laptop address, something like
   **`https://gaming-pc.tail1234.ts.net:8443`**, and copies it to the clipboard. Send it to your laptop (email, notes, etc.).

If Windows Firewall asks about Chrome or Edge, choose **Allow**. Private networks are enough.

**Chrome or Edge on the PC?** TailMic uses Chrome if it's installed, otherwise Edge. Either way it runs in its own TailMic-only profile, so your normal browser (bookmarks, sign-in, tabs) isn't touched. To always use Edge, open `%LOCALAPPDATA%\TailMic\config.json` in Notepad, add `"receiverBrowser": "edge",` after the first `{`, save, and run `Stop-TailMic.cmd` then `Start-TailMic.cmd`. Use `"chrome"` to force Chrome, or `"auto"` for the default.

---

## Step 3 – Every time you play

**On the PC:** nothing to do if you chose "Start with Windows". Otherwise run **`TailMic.cmd start`** (over SSH, see below) or double-click **`Start-TailMic.cmd`**. The TailMic window opens minimized; you never need to look at it.

**On the laptop:**
1. Open the address from Step 2 in **Chrome**, and bookmark it.
2. Pick your microphone and click **Connect**.
   **Noise suppression** (on by default) filters fans, hum and room noise. Turn it off for the purest sound in a quiet room. You can switch it, or change the microphone, while connected, and the page remembers your choice.
3. The first time, allow the microphone. On a Mac, also allow Chrome under **System Settings → Privacy & Security → Microphone**.
4. The status turns green: **Connected**. The meter moves when you talk. **Mute** mutes you, and **Disconnect** stops.

If the connection drops (Wi-Fi, PC restart), the laptop **beeps for a few seconds** so you notice it while you're in Moonlight, and the page reconnects on its own. A short chime tells you it's back. You hear the same beeps if the PC stops playing your microphone (the TailMic window on the PC was closed, or Steam's device disappeared). Untick **Sound alerts** on the page to turn this off.

---

## Step 4 – Choose the microphone in the game

In the game's audio / voice chat settings (usually under **Settings → Audio** or **Voice**), set the input device to:

> **Microphone (Steam Streaming Microphone)**

If a game has no microphone picker, it uses the Windows default. Set it on the PC under **Settings → System → Sound → Input → choose "Microphone (Steam Streaming Microphone)"**. For Steam voice chat, use **Steam → Settings → Voice → Voice Input Device**.

**Check it works:** in **Settings → System → Sound → Input**, the level bar for *Microphone (Steam Streaming Microphone)* should move while you talk into the laptop.

Start TailMic **before** launching the game, because some games only look for microphones at startup.

---

## Start and stop over SSH (without touching the PC)

If the PC runs the Windows **OpenSSH Server** (Settings → System → Optional features), you can control TailMic from the Mac's Terminal over Tailscale. Replace `you` and `gaming-pc` with your Windows user and the PC's Tailscale name, and `C:\TailMic` with where you extracted TailMic:

```
ssh you@gaming-pc "C:\TailMic\TailMic.cmd start"
ssh you@gaming-pc "C:\TailMic\TailMic.cmd status"
ssh you@gaming-pc "C:\TailMic\TailMic.cmd stop"
```

`start` waits until TailMic is ready, then prints something like:

```
   OK  TailMic server: running
   OK  PC window: open
   OK  Output: Speakers (Steam Streaming Microphone)
   --  Call: none (connect from the Mac)
   Mac address: https://gaming-pc.tail1234.ts.net:8443
```

- You must be **logged in to Windows** on the PC (you are, if Moonlight shows your desktop; a locked screen is fine). Programs started straight from an SSH session can't reach the desktop or play audio there, so `start` runs TailMic in your desktop session through the **TailMic** scheduled task.
- `stop` asks the TailMic window and server to close cleanly, and force-closes them only if they're still running after 8 seconds.
- Start TailMic **before** launching the game, because some games only look for microphones at startup.

## Stop, autostart, uninstall

| To... | Do this on the PC |
|---|---|
| Stop TailMic now | `TailMic.cmd stop` (also over SSH), or double-click `Stop-TailMic.cmd` |
| Check if it's ready | `TailMic.cmd status` |
| Start with Windows on / off | `Autostart-On.cmd` / `Autostart-Off.cmd` |
| Change the allowed user | Run `Setup-TailMic.cmd` again |
| Uninstall | `Stop-TailMic.cmd`, `Autostart-Off.cmd`, then in a terminal: `tailscale serve --https=8443 off` and `schtasks /delete /tn TailMic /f`. Delete the TailMic folder and `%LOCALAPPDATA%\TailMic`. |

---

## Troubleshooting

| You see | What to do |
|---|---|
| Laptop: **"TailMic is not running on the PC"** | Double-click `Start-TailMic.cmd` on the PC. |
| **"Steam Streaming Microphone not found"** | Start Steam on the PC. If it still isn't there, the device was never installed: do **one short Steam Remote Play session** to the PC (for example with the free **Steam Link** app on your laptop). Steam installs its streaming audio devices the first time, and you can close it right away and keep using Moonlight. Then run `Setup-TailMic.cmd` again. |
| Laptop: **"The browser on this computer found no Tailscale address"** | Tailscale isn't connected on the laptop. Connect it and click Connect again. |
| PC window: **"No Tailscale address"** | Tailscale isn't connected on the PC. |
| Page won't open / "site can't be reached" | Check that both devices are connected in Tailscale and that MagicDNS and HTTPS are enabled (Step 1). Then run Setup again on the PC. |
| **"Tailscale user ... is not allowed"** | The laptop is signed in to a different Tailscale account. Sign in with the same one, or run Setup on the PC and type that login. |
| Connected, but the game hears nothing | Choose **Microphone (Steam Streaming Microphone)** in the game (Step 4). Restart the game after starting TailMic. Check the level bar in Windows Sound settings. |
| PC window: **"Open in another window"** | TailMic was started twice. The newer window is in use; `TailMic.cmd stop` closes both. |
| `status`: **"PC window: not connected"** | Run `TailMic.cmd start` again. Over SSH this needs you to be logged in to Windows on the PC. |
| `start` over SSH: **"Nobody is logged in to Windows"** | Log in on the PC (for example through Moonlight), then run `start` again. |
| The game hears **noise or garbled sound** | The two halves of the Steam device use different audio formats (`TailMic.cmd status` warns about this). On the PC open **Settings → System → Sound → More sound settings**. On the **Playback** tab open *Speakers (Steam Streaming Microphone)* → **Properties → Advanced**; on the **Recording** tab open *Microphone (Steam Streaming Microphone)* → **Properties → Advanced**. Pick the same **Default Format** in both (48000 Hz), then restart the game. |
| Echo / people hear the game | Use headphones on the laptop. |
| Game sound on the laptop turns **muffled** when you connect | You're using a Bluetooth headset. Bluetooth drops to phone-call quality while its microphone is in use. Use a wired or USB headset, a 2.4 GHz wireless one, or a separate microphone. |
| Logs | `%LOCALAPPDATA%\TailMic\logs` on the PC |

---

## How it stays secure

- **Tailnet only.** The PC page is published with `tailscale serve` (HTTPS with a real certificate), which is reachable only by devices in your tailnet. TailMic's own server listens only on `127.0.0.1` (this PC), so it isn't reachable from your home network or the internet. Funnel is never turned on; setup refuses to continue if it finds Funnel on TailMic's port.
- **Only your user.** Tailscale Serve adds the caller's verified Tailscale login to every request, and removes any copy of it a client tries to send. TailMic accepts only the login saved during setup. Requests from other users or tagged devices are refused.
- **Audio only over Tailscale.** No STUN/TURN servers are used. Before the two browsers connect, the server and both browsers remove every non-Tailscale network address from what each side is **told** about the other, so the Mac only learns the PC's Tailscale address and vice versa. The PC's side is pinned to the PC's **exact** Tailscale IPs (read with `tailscale ip`); the Mac's side must be in Tailscale's address ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Each browser still knows its own LAN addresses internally, but it has nowhere else to send audio. Once connected, both sides check the actual route against the same rules and hang up if it fails. The audio is also end-to-end encrypted by WebRTC (DTLS-SRTP).
- **Other websites can't interfere.** The PC side only accepts requests from TailMic's own window, so a website you open in a browser on the PC can't open it or take it over. On the laptop, other websites can't start or stop a TailMic connection.
- **Nothing extra on your PC.** No npm packages are needed, the PC uses a separate TailMic-only browser profile (your normal Chrome or Edge isn't touched), and Windows default audio devices aren't changed.

## Ports used

| Port | Where | What |
|---|---|---|
| 8443 (HTTPS) | Tailscale Serve, tailnet only | the laptop page |
| 8470 | 127.0.0.1 only | TailMic server, behind Tailscale Serve |
| 8471 | 127.0.0.1 only | the PC receiver window |

To change them, add for example `"httpsPort": 8444` to `%LOCALAPPDATA%\TailMic\config.json` and run Setup again.

---

## For developers

- `app/server.js`: zero-dependency Node.js server (signaling + static files). `app/web/sdp.js` holds the address filter and Opus tuning, shared by the server and both pages.
- `scripts/*.ps1`: Windows PowerShell 5.1 scripts behind the `.cmd` files.
- The dev container includes Node 22, so `node --test tests/unit/` runs inside it.
- Tests (Docker only): `sh tests/run-tests.sh`. They cover:
  - unit tests for address filtering, SDP tuning, user and identity checks, and request limits;
  - an end-to-end test with two real headless Chromium browsers and a fake microphone. It checks that audio arrives, the codec is Opus mono at 100 packets/s, the processing settings are applied (including switching noise suppression on mid-call), and audio plays only to the configured device;
  - a check that the Tailscale-only rule refuses a non-Tailscale network, and that a wrong user is refused.
- **Not tested automatically** (needs a real Windows PC with Tailscale and Steam): the Windows audio device, Tailscale Serve, and the Steam device format check. These steps are small and print clear messages if something is wrong.
