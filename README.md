# TailMic

Use the microphone of your laptop, or any other computer, as the microphone of your Windows gaming PC. The sound travels over Tailscale.

It is made for game streaming with Moonlight and Sunshine: the game runs on the PC, you play somewhere else, and the game's voice chat hears the microphone in front of you. Games see it as a normal microphone called **Microphone (Steam Streaming Microphone)**.

In this guide, the computer you talk into is **the client**, and the gaming PC is **the PC**.

## Install

Before you start:

- **Tailscale** is connected on both computers, and **MagicDNS** and **HTTPS** are enabled at <https://login.tailscale.com/admin/dns>.
- **Steam** is running on the PC.

**1. Download.** On the PC, open PowerShell (Start menu → type `powershell` → Enter) and paste this:

```powershell
$dir = "$HOME\TailMic"
Invoke-WebRequest -UseBasicParsing https://github.com/joetul/TailMic/archive/refs/heads/main.zip -OutFile "$env:TEMP\TailMic.zip"
Remove-Item "$env:TEMP\TailMic-new" -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive "$env:TEMP\TailMic.zip" "$env:TEMP\TailMic-new"
New-Item -ItemType Directory $dir -Force | Out-Null
Copy-Item "$env:TEMP\TailMic-new\TailMic-main\*" $dir -Recurse -Force
```

TailMic is now in the folder `TailMic` inside your user folder (`C:\Users\you\TailMic`).

**2. Set up.** In File Explorer, open that folder and double-click **`Setup-TailMic.cmd`**. Press **Enter** to accept what it suggests. Setup:

- asks which Tailscale user may connect: the one signed in on the client;
- installs Node.js if it is missing;
- checks that Steam's microphone device exists and that its two halves use the same audio format;
- publishes TailMic's page inside your tailnet (the first time, Tailscale may print a link: open it and click **Enable**);
- offers to start TailMic with Windows.

Run it at the PC's desktop (through Moonlight is fine), not over SSH. It is safe to run again at any time.

**3. Open the address.** Setup ends by showing the client address, something like `https://gaming-pc.tail1234.ts.net:8443`. Open it on the client in Chrome, or another Chromium-based browser, and bookmark it.

## Use

1. On the client, open the address, pick your microphone and click **Connect**. Allow the microphone the first time. On a Mac, also allow the browser under **System Settings → Privacy & Security → Microphone**.
2. In the game's voice settings, choose **Microphone (Steam Streaming Microphone)** as the input device.
3. Click **Tone check** on the page once. It tells you whether the game hears you at the right speed and pitch.

Good to know:

- **Start TailMic before the game.** Some games only look for microphones when they start. If you chose "Start with Windows", there is nothing to do on the PC. Otherwise double-click `Start-TailMic.cmd`.
- **Use headphones on the client.** Echo cancellation is off for the best sound, so game sound from speakers would go back into the microphone.
- **If the connection drops**, the client beeps for a few seconds and reconnects on its own. A short chime tells you it is back. Untick **Sound alerts** to turn this off.
- **Mute** stays on if the call reconnects.
- **Noise suppression** (on by default) filters fans and hum. Turn it off for the purest sound in a quiet room.
- **A game without a microphone setting** uses the Windows default. Choose it on the PC under **Settings → System → Sound → Input**.

## How it works

```
CLIENT (where you sit)                    PC (where the game runs)

browser page ── audio over Tailscale ──▶ TailMic window ──▶ Speakers (Steam Streaming Microphone)
                                                                         │
                                               the game ◀── Microphone (Steam Streaming Microphone)
```

- **On the PC**, TailMic is a small local server and one minimized browser window. Tailscale Serve publishes its page over HTTPS, to your tailnet only.
- **On the client**, nothing is installed. You open that page in a browser, and the page sends your microphone.
- **The two browsers connect directly** over Tailscale with WebRTC, the technology behind video calls in a browser. The audio is Opus at 48 kHz in 10 ms packets, and it is encrypted.
- **Steam provides the virtual microphone.** Its device has two halves: what is played into *Speakers (Steam Streaming Microphone)* comes out of *Microphone (Steam Streaming Microphone)*. The TailMic window plays your voice into the first half, and the game listens to the second.
- **Nothing else changes.** Moonlight, Sunshine and your default speakers and microphone are left alone.

## What you need

| On the PC (Windows 11) | On the client (Mac, Windows, Linux or Chromebook) |
|---|---|
| Tailscale | Tailscale, signed in as the user you allow in setup |
| Steam, running | A microphone or headset |
| Chrome or Edge (Edge comes with Windows) | Chrome, or another Chromium-based browser (Edge, Brave, ...) |
| Node.js; setup installs it for you | Nothing else |

Firefox, Safari, phones and tablets are not tested. More about browsers, tagged Tailscale devices and access controls is in [Setup details and options](docs/advanced.md).

## Test what the game hears

While connected, the client page lets you hear, on the client, exactly what a game gets from Steam's microphone. Use headphones.

| Button | What it does |
|---|---|
| **Tone check** | Sends a test tone for about 3 seconds and measures the pitch that comes back. It says in plain words whether speed and pitch are right, and how to fix it if not. |
| **Record 5 s and play back** | Records what the game hears while you talk, then plays it to you. |
| **Listen live** | Plays what the game hears, a moment late, until you click **Stop listening**. |

Run **Tone check** once after setup, and whenever people say you sound strange. The PC listens only while a test runs, only to Steam's microphone, and nothing is saved.

## Commands

| To... | Double-click on the PC | Or run, also over SSH |
|---|---|---|
| Start | `Start-TailMic.cmd` | `TailMic.cmd start` |
| Stop | `Stop-TailMic.cmd` | `TailMic.cmd stop` |
| Check that everything is ready | | `TailMic.cmd status` |
| Update to the latest version | `Update-TailMic.cmd` | `TailMic.cmd update` |
| Change the allowed user | `Setup-TailMic.cmd` | `TailMic.cmd set-user you@example.com` |
| Start with Windows, on or off | `Autostart-On.cmd`, `Autostart-Off.cmd` | |

If the PC runs the Windows OpenSSH Server, you can do all of this from the client. Replace `you` and `gaming-pc` with your Windows user and the PC's Tailscale name:

```
ssh you@gaming-pc ".\TailMic\TailMic.cmd start"
ssh you@gaming-pc ".\TailMic\TailMic.cmd status"
ssh you@gaming-pc ".\TailMic\TailMic.cmd stop"
ssh you@gaming-pc ".\TailMic\TailMic.cmd update"
```

Over SSH you must be logged in to Windows on the PC; a locked screen is fine. `start` and `status` print a short report, which begins with the version that is running.

## Update

Double-click **`Update-TailMic.cmd`** on the PC, or run `TailMic.cmd update` over SSH. It downloads the latest TailMic from this repository, restarts TailMic if it was running, and shows the status. Your settings are kept. Reload the page on the client afterwards.

If your TailMic folder has no `Update-TailMic.cmd` (installed before version 1.2), see [Setup details and options](docs/advanced.md#update).

## Troubleshooting

`TailMic.cmd status` on the PC is the first thing to try: it names what is wrong.

| You see | What to do |
|---|---|
| Client: **"TailMic is not running on the PC"** | Start it: `Start-TailMic.cmd` on the PC, or `TailMic.cmd start`. |
| **"Steam Streaming Microphone not found"** | Start Steam on the PC. If the device is still missing, it was never installed: on the PC, turn on **Steam → Settings → Remote Play → Enable Remote Play**. Install the free **Steam Link** app on the client, connect to the PC once (enter the PIN it shows), and close Steam Link again. Then run `Setup-TailMic.cmd` again. *Speakers (Steam Streaming Speakers)* is a different device and doesn't count. |
| Your voice is **slow, deep or garbled** in the game | The two halves of Steam's device use different audio formats; a freshly installed device often does. `TailMic.cmd status` prints the exact format to pick. On the PC, open **Settings → System → Sound → More sound settings → Recording** tab → *Microphone (Steam Streaming Microphone)* → **Properties → Advanced**, and set **Default Format** to exactly that. Channels, bits and Hz must all match. Then restart TailMic and the game. |
| Connected, but the game hears nothing | Choose **Microphone (Steam Streaming Microphone)** in the game, and restart the game after starting TailMic. |
| The page won't open | Check that both computers are connected in Tailscale and that MagicDNS and HTTPS are enabled. Then run Setup again on the PC. |
| **"Tailscale user ... is not allowed"**, or `status` says **"Allowed user: NONE"** | Allow the user that is signed in on the client: `TailMic.cmd set-user <that login>` on the PC. |
| `status`: **"PC window: open, but it is waiting for permission"** | At the PC's desktop, click **Allow** in the TailMic window. It is needed once. |
| Game sound on the client turns **muffled** when you connect | A Bluetooth headset drops to phone-call quality while its microphone is in use. Use a wired or USB headset, or a separate microphone. |

The full list is in [Troubleshooting](docs/troubleshooting.md). Logs are in `%LOCALAPPDATA%\TailMic\logs` on the PC.

## Security and privacy

- **Tailnet only.** The page is published with Tailscale Serve, and TailMic's own server listens only on the PC itself. Nothing is opened to the internet or your home network, and Funnel is never used.
- **Only your user.** Tailscale tells TailMic who is calling, and TailMic accepts only the Tailscale login you chose in setup.
- **Audio only over Tailscale**, directly between the two browsers and encrypted. No STUN or TURN servers are used.
- **Nothing is stored or sent elsewhere.** No audio is saved, there is no analytics, and the pages load nothing from the internet.
- **The PC listens only during a test**, and only to Steam's microphone.

TailMic trusts the PC itself, your Tailscale account and this repository, which is what you download and run. The details are in [Security and privacy](docs/security.md).

## More

- [Setup details and options](docs/advanced.md): browsers, tagged devices and access controls, ports, SSH, uninstall
- [Troubleshooting](docs/troubleshooting.md): the full list
- [Security and privacy](docs/security.md): how it stays secure, what is stored, what it costs on the PC
- [For developers](docs/development.md): how the code is laid out, and the tests
