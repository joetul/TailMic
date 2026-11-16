# Troubleshooting

Start with the status report: it names what is wrong. Double-click `Status-TailMic.cmd` on the PC, or run `TailMic.cmd status` (also over SSH). Logs are in `%LOCALAPPDATA%\TailMic\logs` on the PC.

For how to install and use TailMic, see the [README](../README.md).

## Starting and connecting

| You see | What to do |
|---|---|
| Client: **"TailMic is not running on the PC"** | Double-click `Start-TailMic.cmd` on the PC, or run `TailMic.cmd start` (also over SSH). |
| The page won't open, or "site can't be reached" | Check that both computers are connected in Tailscale and that MagicDNS and HTTPS are enabled at <https://login.tailscale.com/admin/dns>. Then run setup again on the PC. |
| **"Tailscale user ... is not allowed"** | The client is signed in as a different Tailscale user than the allowed one. Sign in as that user, or allow the one in the message: `TailMic.cmd set-user <that login>` on the PC (also over SSH). |
| `status`: **"Allowed user: NONE"** | No allowed user was set during setup. Run `TailMic.cmd set-user <your Tailscale login>` on the PC (also over SSH). |
| Client: **"The browser on this computer found no Tailscale address"** | Tailscale isn't connected on the client. Connect it and click Connect again. In Brave, also check that **WebRTC IP handling policy** is on **Default** (Settings → Privacy and security). |
| PC window: **"No Tailscale address"** | Tailscale isn't connected on the PC. |
| PC window: **"Open in another window"** | TailMic was started twice. The newer window is in use; `TailMic.cmd stop` closes both. |
| `status`: **"PC window: open, but it is waiting for permission"** | The TailMic window asks to use audio devices. At the PC's desktop (through Moonlight is fine), click **Allow** in the TailMic window; it is needed once. Normally TailMic sets this permission up by itself. |
| `status`: **"PC window: not connected"** | Run `TailMic.cmd start` again. Over SSH this needs you to be logged in to Windows on the PC. |
| `start` over SSH: **"Nobody is logged in to Windows"** | Log in on the PC (for example through Moonlight), then run `start` again. |
| `start` over SSH: **"Could not create the TailMic scheduled task"** | Run `Setup-TailMic.cmd` once at the PC's desktop (through Moonlight is fine). It creates the task, and `start` then only has to run it. |

## Steam's microphone device

| You see | What to do |
|---|---|
| **"Steam Streaming Microphone not found"** | Start Steam on the PC. If it still isn't there, the device was never installed. *Speakers (Steam Streaming Speakers)* is a **different** device (Sunshine can add it) and doesn't count: you need *Speakers (Steam Streaming Microphone)* and *Microphone (Steam Streaming Microphone)*. To install them: **1.** on the PC, turn on **Steam → Settings → Remote Play → Enable Remote Play**; **2.** install the free **Steam Link** app on the client and connect to the PC once, entering the PIN it shows on the PC; **3.** close Steam Link right away, and keep using Moonlight. Then run `Setup-TailMic.cmd` again and check the format (the next row): a freshly installed device usually needs that fix once. |
| The game hears your voice **slow, deep or "dark"**, or **noise or garbled sound** | The two halves of the Steam device use different audio formats. That always breaks the sound, and a freshly installed device often starts out this way. `TailMic.cmd status` reports it as an error and prints the exact format to pick; **Tone check** on the client page finds it too. On the PC open **Settings → System → Sound → More sound settings → Recording** tab → *Microphone (Steam Streaming Microphone)* → **Properties → Advanced**, and set **Default Format** to exactly what `status` prints for the Speakers half, for example **"2 channel, 32 bit, 48000 Hz"**. **Channels, bits and Hz must all match**; the same Hz alone is not enough. (2 channels played into 1 channel gives half speed, an octave lower. 48000 Hz into 44100 Hz is about 8% too slow, with crackle.) Change the Microphone half: the Playback tab doesn't show the channel count of the Speakers half. Then run `TailMic.cmd stop`, `TailMic.cmd start` and `TailMic.cmd status`, and restart the game. |
| Test: **"The PC cannot find Microphone (Steam Streaming Microphone)"** | Start Steam on the PC. On the PC, under **Settings → System → Sound → Input**, check that the device exists and is not disabled. |

**What Tone check measures.** It sends a 1000 Hz tone instead of your microphone for about 3 seconds (the game hears the beep) and measures the pitch that comes back. About 500 Hz back means half speed: the two halves of the Steam device have a different number of channels. About 920 Hz means their sample rates differ. Silence means nothing arrives.

## Sound

| You see | What to do |
|---|---|
| Connected, but the game hears nothing | Choose **Microphone (Steam Streaming Microphone)** in the game. Restart the game after starting TailMic. On the PC, the level bar under **Settings → System → Sound → Input** should move while you talk. |
| Client: **"Connected, but the game cannot hear you"** | The PC stopped playing your microphone: the TailMic window on the PC was closed, or Steam's device disappeared. Start TailMic on the PC again, and check that Steam is running. |
| Echo, or people hear the game | Use headphones on the client. |
| Game sound on the client turns **muffled** when you connect | You're using a Bluetooth headset. Bluetooth drops to phone-call quality while its microphone is in use. Use a wired or USB headset, a 2.4 GHz wireless one, or a separate microphone. |
| Steam voice chat doesn't hear you | Choose the device under **Steam → Settings → Voice → Voice Input Device**. |

## After an update

| You see | What to do |
|---|---|
| `status`: **"running, but NOT the files in this folder"** | TailMic was updated but not restarted, or it runs from another folder. Run `TailMic.cmd stop`, then `TailMic.cmd start`. |
| A button or message described in the README is **missing** on the client page | The PC runs an older TailMic. [Update it](advanced.md#update), then reload the page. |
