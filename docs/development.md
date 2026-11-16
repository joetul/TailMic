# For developers

## Layout

- `app/server.js`: zero-dependency Node.js server (signaling + static files). `app/web/sdp.js` holds the address filter and Opus tuning, shared by the server and both pages.
- `app/web/client.js` and `app/web/receiver.js`: the client page and the PC window.
- `app/web/tone.js`: the tone check's pitch measurement and verdicts.
- `scripts/*.ps1`: Windows PowerShell 5.1 scripts behind the `.cmd` files. `scripts/receiver-preferences.json` is what `start.ps1` writes into the TailMic-only browser profile: the permission for TailMic's own page.
- `scripts/update.ps1` is the update. `Update-TailMic.cmd` and the `update` part of `TailMic.cmd` call it in a single line, on purpose: the update replaces those files while they run, and `cmd.exe` would otherwise go on reading commands from the new file.
- `app/package.json` holds the version number that `TailMic.cmd status` shows. Raise it when you publish a change, so users can tell which version they run.

The audio is Opus mono at 48 kHz in 10 ms packets. Echo cancellation and auto gain are off so the voice isn't mangled; noise suppression is the user's choice.

## Tests

The tests run in Docker only, so nothing is installed on your computer:

```
sh tests/run-tests.sh
```

To run only some of the end-to-end tests, give part of a test's name: `ONLY='messages keep up' sh tests/run-tests.sh`.

They cover:

- unit tests (Node 22) for address filtering, SDP tuning, user and identity checks, request limits, the tone check's verdicts, who may start a test, and the version fingerprint;
- script checks in PowerShell 7 on Linux: every script parses, the allowed-user rules (a tagged PC, device names), the settings file, and that `status` notices an outdated running copy, the prepared browser profile, and a complete update from a zip made on the spot (old, missing and unrelated files, a second run, a download that is not TailMic);
- an end-to-end test with two real headless Chromium browsers and a fake microphone. It checks that audio arrives, the codec is Opus mono at 100 packets/s, the processing settings are applied (including switching noise suppression on mid-call), and audio plays only to the configured device;
- **Test what the game hears**, with a stand-in for Steam's device: audio comes back, the tone check reports OK, half speed (channel mismatch), a sample-rate mismatch and silence correctly, the PC listens only during a test, and it refuses any other microphone;
- the messages on both pages keep up with what is true: a note about a finished call or test goes away again, Mute survives a reconnect, a PC that stopped playing the microphone stays a warning, and a PC window that was replaced or lost its server does not say "Ready";
- the PC window in a browser profile prepared exactly as `start.ps1` does it, under the page's real security policy: it gets its devices without a prompt and without opening a microphone, other sites in that profile get nothing, and without the permission `status` says so;
- resources: 25 calls in a row leave no connection, microphone or audio context open on either side;
- a check that the Tailscale-only rule refuses a non-Tailscale network, and that a wrong user is refused.

**Not tested automatically** (needs a real Windows PC with Tailscale and Steam): the Windows audio device, Tailscale Serve, the scheduled task (also over SSH), and the Steam device format check. These steps are small and print clear messages if something is wrong.
