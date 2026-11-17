# Security and privacy

The short version is in the [README](../README.md#security-and-privacy). This page has the details.

## How it stays secure

- **Tailnet only.** The PC page is published with `tailscale serve` (HTTPS with a real certificate), which is reachable only by devices in your tailnet. TailMic's own server listens only on `127.0.0.1` (this PC), so it isn't reachable from your home network or the internet. Funnel is never turned on; setup refuses to continue if it finds Funnel on TailMic's port.
- **Only your user.** Tailscale Serve adds the caller's verified Tailscale login to every request, and removes any copy of it a client tries to send. TailMic accepts only the login saved during setup. Requests from other users or tagged devices are refused.
- **Audio only over Tailscale.** No STUN/TURN servers are used. Before the two browsers connect, the server and both browsers remove every non-Tailscale network address from what each side is **told** about the other, so the client only learns the PC's Tailscale address and vice versa. The PC's side is pinned to the PC's **exact** Tailscale IPs (read with `tailscale ip`); the client's side must be in Tailscale's address ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Each browser still knows its own LAN addresses internally, but it has nowhere else to send audio. Once connected, both sides check the actual route against the same rules and hang up if it fails. The audio is also end-to-end encrypted by WebRTC (DTLS-SRTP).
- **Other websites can't interfere.** The PC side only accepts requests from TailMic's own window, so a website you open in a browser on the PC can't open it or take it over. On the client, other websites can't start or stop a TailMic connection.
- **One site, one permission.** The TailMic window runs in its own browser profile. Start-TailMic prepares that profile so that exactly one site, TailMic's own page on this PC, may use audio devices without asking. The page needs that to see the names of the audio devices (to find Steam's), and for the test below; this way it works with nobody at the PC. No other site gets anything, even if it were opened in that profile, and TailMic does not open the PC's own microphone. (Only if the prepared permission is missing does the window ask once; clicking Allow then opens the default microphone for an instant.)
- **Nothing extra on your PC.** No npm packages are needed, the PC uses a separate TailMic-only browser profile (your normal browser isn't touched), and Windows default audio devices aren't changed. TailMic never changes a device's audio format either; if the Steam device needs the format fix, you do it yourself in Windows.

## When the PC listens

In normal use TailMic only plays sound on the PC. **Test what the game hears** is the only time it listens there. The audio comes back over the same connection as your microphone: no extra port, and only over Tailscale.

- It starts when you click one of the test buttons, and stops when the test ends or when you disconnect. The PC also stops by itself 30 seconds after the client last asked, so it can't be left listening if the client goes away. (**Listen live** keeps asking for as long as you leave it on.)
- It listens to *Microphone (Steam Streaming Microphone)* only, found by name. It refuses any other microphone.
- Nothing is saved on the PC. The 5-second recording is kept in the client page's memory and is gone after it has played.
- Only the allowed Tailscale user can start a test, and only during their own call.
- While a test runs, Windows shows its **microphone-in-use** indicator for the TailMic browser, the TailMic window shows **Game-hears test: ON**, and `TailMic.cmd status` shows it too.

## What TailMic trusts

TailMic protects the connection between the client and your PC from everyone else. It does not protect you from these, so keep them yours:

- **The gaming PC, and everything that runs on it.** Programs on the PC, and other Windows accounts on it, can reach TailMic's two local ports, and can already record the Steam microphone directly. Also, the page the client opens comes from the PC, and you allowed that page to use the client's microphone. So use TailMic on a PC that is yours; if other people log in to it, keep the TailMic folder inside your user folder, where the install puts it.
- **Your Tailscale account.** Whoever can sign in as the allowed user can connect. Turn on two-factor authentication at your login provider.
- **The download.** Installing and updating (`Update-TailMic.cmd`) fetch whatever is in the GitHub repository at that moment, over HTTPS, and run it.

## What is stored and sent

- **No audio is ever stored**, on either side. The 5-second test recording lives in the client page's memory until it has played.
- **Nothing is sent to anyone else.** The pages load no fonts, scripts or anything else from the internet, there is no analytics, and the audio goes directly between your two browsers over Tailscale.
- **On the PC**, in `%LOCALAPPDATA%\TailMic`: the settings (the allowed login, the PC's Tailscale name, ports), the TailMic-only browser profile, and logs. The logs record when TailMic started, who connected or was refused (Tailscale login), the Tailscale addresses used, and when a test started and stopped. Logs older than 14 days are deleted when TailMic starts.
- **On the client**, in the browser's storage for the TailMic page: which microphone you picked and the two checkboxes.

## What it costs on the PC

Two things run on the PC, and nothing else stays behind: a small Node.js program (roughly 60 MB of memory) and one minimized browser window with a single page. Both sit idle until you connect; a call is one audio stream of at most about 130 kbit/s.

- **It doesn't grow.** Every call's connection, microphone and timers are closed when it ends, and the tests check that after many calls in a row.
- **The browser window is kept quiet.** It is started with the browser's own background work switched off (component downloads, update and safety-list checks, reports), because it only ever shows TailMic's page.
- **Little disk use.** Logs are a few lines per call and are deleted after 14 days.

The browser window is the larger part (like any open browser window, a few hundred MB). To see the real numbers on your PC, open Task Manager and look for `node.exe` and the browser entries that started with TailMic.

The ports TailMic uses are listed in [Setup details and options](advanced.md#ports).
