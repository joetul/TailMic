// TailMic receiver (runs in a dedicated Chrome or Edge window on the gaming PC).
// Plays the incoming WebRTC audio ONLY into "Speakers (Steam Streaming Microphone)",
// so games hear it on "Microphone (Steam Streaming Microphone)".
//
// Only while the client runs "Test what the game hears" does this page also
// listen: it opens "Microphone (Steam Streaming Microphone)" (that device and no
// other) and sends its sound back to the client over the same connection. Nothing
// is stored, and it stops when the test ends, the call ends, or after 30 seconds.
import { filterCandidates, selectedPair, isAllowedAddress, isAllowedEndpoint } from './sdp.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), statusText: $('statusText'), msg: $('msg'), meter: $('meter'),
  permRow: $('permRow'), perm: $('perm'), device: $('device'), users: $('users'), user: $('user'),
  route: $('route'), rtt: $('rtt'), buf: $('buf'), lost: $('lost'), test: $('test'),
};
/** @type {HTMLAudioElement} */
const audio = $('audio');

let cfg = null;
let permOk = false;
let asking = false;  // waiting for someone at the PC to answer the browser's permission question
let noInput = false; // this PC has no audio input device at all (so no Steam Streaming Microphone either)
let sinkId = null;
let sinkLabel = '';
let sinkApplied = false;
let pc = null;
let sessionId = null;
let events = null;
let lastReported = '';
let returnSender = null; // sends audio back to the client; has no track (sends nothing) except during a test
let test = null;         // the running "what the game hears" test: { track, timer }
// The one microphone a test may listen to, found by this part of its name. Fixed
// here on purpose, not a setting: no change to config.json can point a test at
// another microphone on the PC.
const TEST_MICROPHONE = 'steam streaming microphone';
const TEST_MAX_MS = 30000; // a test stops by itself after this long unless the client asks again
// "The client" is the computer that sends its microphone: usually a laptop, but
// any computer with a Chromium browser will do (the README uses the same word).
const WAITING = 'Waiting for the client to connect.';
const NOTE_MS = 15000; // why the last call ended stays on screen this long, then WAITING is back
let noteTimer = 0;
let online = false;   // connected to the TailMic server on this PC
let finished = false; // this window was told to stop (TailMic stopped, or another window took over)
const timers = [];

window.tailmic = { stats: {} };

function setStatus(kind, text, msg = '', isErr = false) {
  clearTimeout(noteTimer);
  ui.status.dataset.s = kind;
  ui.statusText.textContent = text;
  ui.msg.textContent = msg;
  ui.msg.classList.toggle('err', isErr);
  document.title = `TailMic (PC) - ${text}`;
  window.tailmic.status = text;
}

/**
 * No call. `note` says why the last one ended; it makes way for the usual line
 * after a while, so the window does not say "the client disconnected" for hours.
 * A `problem` (red) stays until the next call.
 */
function showReady(note = '', problem = false) {
  setStatus('ok', 'Ready', note || WAITING, problem);
  if (note && !problem) noteTimer = setTimeout(() => { if (!pc && !finished) setStatus('ok', 'Ready', WAITING); }, NOTE_MS);
}

/** Put the status line back to what is true right now (after a problem went away). */
function showCurrent() {
  const st = pc ? pc.connectionState : '';
  if (!pc) showReady();
  else if (st === 'connected') setStatus('ok', 'Connected', `Receiving ${ui.user.textContent}'s microphone.`);
  else if (st === 'disconnected') setStatus('warn', 'Connection interrupted...');
  else setStatus('warn', 'Connecting...', `Incoming call from ${ui.user.textContent}`);
}

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

function report() {
  if (finished) return; // another window (or nobody) speaks for this PC now
  const st = { deviceFound: !!(sinkId && sinkApplied), deviceLabel: sinkLabel, state: pc ? pc.connectionState : 'idle', testing: !!test, needsPermission: asking };
  const key = JSON.stringify(st);
  if (key === lastReported) return;
  lastReported = key;
  api('/api/rstatus', st).catch(() => { lastReported = ''; });
}

// Chrome/Edge only show device names (and real IP addresses for WebRTC) to pages
// that have microphone permission. Start-TailMic gives this TailMic-only browser
// profile that permission for this page alone, and then nothing needs to be
// opened: the names are simply there. Only if that did not work (the page then
// sees no names) does it ask, by opening a microphone and closing it right away.
const PERMISSION_HELP = 'Click "Allow" when the browser asks (one time only). TailMic uses this to find the Steam Streaming Microphone device, and for "Test what the game hears" when you run that test. Nothing is stored.';
let unlocking = null;
function unlock() {
  if (!unlocking) unlocking = doUnlock().finally(() => { unlocking = null; });
  return unlocking;
}

async function doUnlock() {
  try {
    if ((await navigator.mediaDevices.enumerateDevices()).some((d) => d.label)) {
      permOk = true;
      noInput = false;
      ui.permRow.classList.add('hidden');
      return;
    }
  } catch { /* ask below */ }
  try {
    if (!noInput) { // (not when only re-checking whether an audio device has appeared)
      asking = true;
      setStatus('bad', 'Needs permission', PERMISSION_HELP, true);
      report();
    }
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    asking = false;
    permOk = true;
    noInput = false;
    ui.permRow.classList.add('hidden');
    setStatus('warn', 'Starting...');
  } catch (e) {
    permOk = false;
    // No audio input device on this PC: nothing to allow. It also means the Steam
    // Streaming Microphone is not installed, so say that instead of asking for permission.
    noInput = e.name === 'NotFoundError';
    asking = !noInput; // refused: the "Allow access" button stays until someone allows it
    if (noInput) {
      ui.permRow.classList.add('hidden');
      ui.device.textContent = 'NOT FOUND (this PC has no audio input device)';
      setStatus('bad', 'Steam Streaming Microphone not found',
        'This PC has no microphone device at all, so the Steam Streaming Microphone is not installed. See "Troubleshooting" in the README.', true);
      return;
    }
    ui.permRow.classList.remove('hidden');
    setStatus('bad', 'Needs permission', PERMISSION_HELP, true);
    report();
  }
}

// Look for the output device again; if this PC had no input device before, check whether one appeared.
async function refreshDevice() {
  if (finished) return;
  if (!permOk && noInput) await unlock();
  if (permOk) await findDevice();
}

async function findDevice() {
  if (finished) return;
  const devs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const want = cfg.outputDeviceMatch.toLowerCase();
  const not = (cfg.outputDeviceExclude || '').toLowerCase();
  const match = devs.find((d) => d.label.toLowerCase().includes(want) && !(not && d.label.toLowerCase().includes(not)));
  window.tailmic.outputs = devs.map((d) => d.label);
  if (!match) {
    sinkId = null; sinkLabel = ''; sinkApplied = false;
    audio.muted = true;
    audio.pause();
    ui.device.textContent = `NOT FOUND. Outputs seen: ${devs.map((d) => d.label || '(no name)').join('; ') || 'none'}`;
    if (permOk) {
      setStatus('bad', 'Steam Streaming Microphone not found',
        'Start Steam on this PC. If it is running, see "Troubleshooting" in the README (the device may not be installed yet).', true);
    }
    report();
    return;
  }
  if (match.deviceId !== sinkId || !sinkApplied) {
    sinkId = match.deviceId;
    sinkLabel = match.label;
    sinkApplied = false;
    try {
      // Route BEFORE any audio is attached, so nothing ever plays on the real speakers.
      await audio.setSinkId(sinkId);
      sinkApplied = true;
      audio.muted = false;
      // The device came back (e.g. Steam restarted) during a call: resume playing.
      if (audio.srcObject && audio.paused) audio.play().catch(() => {});
    } catch (e) {
      audio.muted = true;
      setStatus('bad', 'Cannot use output device', e.message, true);
    }
  }
  ui.device.textContent = sinkApplied ? sinkLabel : `${sinkLabel} (could not select)`;
  // The device is there (again): if the status line still shows a problem, put it
  // right. Not while the server is unreachable: that problem is still true.
  if (sinkApplied && online && ui.status.dataset.s !== 'ok') showCurrent();
  report();
}

// ---------- "Test what the game hears" ----------
// The client asks (through the server, which checks the Tailscale user) to hear
// what a game gets from "Microphone (Steam Streaming Microphone)".

/** Stop listening to the Steam microphone (safe to call when no test runs). */
function stopTest() {
  if (!test) return;
  clearTimeout(test.timer);
  test.track.onended = null;
  test.track.stop();
  returnSender?.replaceTrack(null).catch(() => {});
  test = null;
  ui.test.textContent = 'off';
  report();
}

async function startTest(d) {
  const peer = pc;
  const fail = (error, message) => api('/api/testack', { id: d.id, ok: false, error, message }).catch(() => {});
  if (!peer || d.id !== sessionId || peer.connectionState !== 'connected' || !returnSender) {
    return fail('no_call', 'The PC has no connected call to test.');
  }
  if (test) {
    // Already listening (live monitor asking for more time): just run on.
    clearTimeout(test.timer);
    test.timer = setTimeout(stopTest, TEST_MAX_MS);
    return api('/api/testack', { id: d.id, ok: true, device: test.track.label }).catch(() => {});
  }
  let track = null;
  try {
    // Only the Steam microphone, found by name. Never the default or any other microphone.
    const want = TEST_MICROPHONE;
    const dev = (await navigator.mediaDevices.enumerateDevices())
      .find((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications' && x.label.toLowerCase().includes(want));
    if (!dev) return fail('no_capture_device', 'The PC cannot find "Microphone (Steam Streaming Microphone)". Is Steam running on the PC?');
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    track = s.getAudioTracks()[0];
    // Make sure the browser really opened that device.
    if (!track || !track.label.toLowerCase().includes(want)) throw new Error(`the browser opened "${track ? track.label : 'nothing'}" instead`);
    if (pc !== peer || d.id !== sessionId || test) throw new Error('the call ended');
    await returnSender.replaceTrack(track);
    if (pc !== peer) throw new Error('the call ended');
    test = { track, timer: setTimeout(stopTest, TEST_MAX_MS) };
    track.onended = stopTest; // Steam's device disappeared
    ui.test.textContent = `ON - sending "${track.label}" back to the client`;
    report();
    // If the client gave up or stopped the test meanwhile, the server refuses this
    // confirmation: stop at once instead of listening until the 30-second limit.
    const ack = await api('/api/testack', { id: d.id, ok: true, device: track.label }).catch(() => null);
    if (!ack || !ack.ok) stopTest();
  } catch (e) {
    if (test && test.track === track) stopTest();
    else track?.stop(); // never leave the microphone open after a failed start
    await fail('test_failed', `The PC could not listen to "Microphone (Steam Streaming Microphone)": ${e.message}`);
  }
}

function closePc(reason = '', problem = false) {
  stopTest();
  // Tell the server this call is over, so it doesn't stay listed as active.
  if (sessionId) api('/api/ended', { id: sessionId }).catch(() => {});
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.close();
    pc = null;
  }
  sessionId = null;
  returnSender = null;
  audio.srcObject = null;
  ui.user.textContent = ui.route.textContent = ui.rtt.textContent = ui.buf.textContent = ui.lost.textContent = '-';
  ui.meter.style.width = '0';
  // (Without the output device, or without the server, the status line already says what is wrong.)
  if (sinkApplied && online && !finished) showReady(reason, problem);
  report();
}

function waitForIce(peer, ms) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (peer.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ms);
    peer.addEventListener('icegatheringstatechange', check);
  });
}

let latestOfferId = null;
async function onOffer(d) {
  if (finished || d.id !== latestOfferId) return; // a newer call already arrived; this one was replaced
  closePc();
  // Refresh settings (the PC's Tailscale IPs may not have been known at start-up).
  try { const c = await api('/api/rconfig'); if (c && Array.isArray(c.allowedUsers)) cfg = c; } catch { /* keep the old ones */ }
  if (!permOk) await unlock();
  await findDevice();
  if (d.id !== latestOfferId) return;
  if (!sinkApplied) {
    await api('/api/answer', { id: d.id, error: 'no_output_device', message: 'The PC cannot find "Speakers (Steam Streaming Microphone)". Is Steam running on the PC?' });
    return;
  }
  sessionId = d.id;
  ui.user.textContent = d.user;
  setStatus('warn', 'Connecting...', `Incoming call from ${d.user}`);
  const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  pc = peer;
  peer.ontrack = (ev) => {
    if (pc !== peer || !sinkApplied) return; // never play a stale call, never play to the wrong device
    audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
    audio.play().catch((e) => setStatus('bad', 'Playback blocked', e.message, true));
  };
  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    const st = peer.connectionState;
    if (st === 'connected') setStatus('ok', 'Connected', `Receiving ${d.user}'s microphone.`);
    else if (st === 'disconnected') setStatus('warn', 'Connection interrupted...');
    else if (st === 'failed' || st === 'closed') closePc('Connection ended.');
    report();
  };
  // If this call was replaced or hung up while we were busy, drop only THIS peer.
  const stale = () => {
    if (pc === peer) return false;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.close();
    return true;
  };
  try {
    await peer.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    if (stale()) return;
    // Offer a way back to the client for "Test what the game hears". It carries
    // no track, so nothing is sent until the client starts a test.
    const tx = peer.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === 'audio');
    if (tx) {
      tx.direction = 'sendrecv';
      returnSender = tx.sender;
    }
    await peer.setLocalDescription(await peer.createAnswer());
    if (stale()) return;
    await waitForIce(peer, 3000);
    if (stale()) return;
    const f = filterCandidates(peer.localDescription.sdp, cfg.allowedCidrs, cfg.pcIps);
    if (!f.kept.length) {
      await api('/api/answer', { id: d.id, error: 'receiver_no_tailscale', message: 'The browser on the PC found no Tailscale address. Is Tailscale connected on the PC?' });
      closePc();
      setStatus('bad', 'No Tailscale address', 'The browser on this PC found no Tailscale address. Is Tailscale connected?', true);
      return;
    }
    const r = await api('/api/answer', { id: d.id, sdp: f.sdp });
    if (!r.ok && !stale()) closePc();
  } catch (e) {
    await api('/api/answer', { id: d.id, error: 'receiver_error', message: e.message }).catch(() => {});
    if (!stale()) closePc();
  }
}

async function stats() {
  const peer = pc;
  if (!peer) return;
  const report = await peer.getStats();
  if (peer !== pc) return;
  const pair = selectedPair(report);
  if (pair && pair.local && pair.remote) {
    if (!isAllowedEndpoint(pair.local, cfg.allowedCidrs, cfg.pcIps) || !isAllowedAddress(pair.remote, cfg.allowedCidrs)) {
      closePc(`Blocked a connection that was not over Tailscale (${pair.local} -> ${pair.remote}).`, true);
      return;
    }
    ui.route.textContent = `${pair.remote} → ${pair.local} (Tailscale)`;
    if (pair.rtt !== undefined) ui.rtt.textContent = `${Math.round(pair.rtt * 1000)} ms`;
  }
  let inb = null;
  report.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') inb = s; });
  if (inb) {
    const level = inb.audioLevel || 0;
    const db = 20 * Math.log10(level || 1e-6);
    ui.meter.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    const bufMs = inb.jitterBufferEmittedCount ? Math.round((inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000) : null;
    if (bufMs !== null) ui.buf.textContent = `${bufMs} ms`;
    ui.lost.textContent = `${inb.packetsLost || 0} of ${inb.packetsReceived || 0}`;
    const codec = inb.codecId && report.get(inb.codecId);
    window.tailmic.stats = {
      connectionState: peer.connectionState,
      route: pair,
      bytesReceived: inb.bytesReceived,
      packetsReceived: inb.packetsReceived,
      packetsLost: inb.packetsLost,
      audioLevel: level,
      totalAudioEnergy: inb.totalAudioEnergy,
      jitterBufferMs: bufMs,
      codec: codec ? { mimeType: codec.mimeType, channels: codec.channels, fmtp: codec.sdpFmtpLine } : null,
      sinkId: audio.sinkId,
      sinkLabel,
    };
  }
}

function connectEvents() {
  events = new EventSource('/api/events');
  // Handle calls strictly one at a time, newest wins.
  let chain = Promise.resolve();
  events.addEventListener('offer', (e) => {
    const d = JSON.parse(e.data);
    latestOfferId = d.id;
    chain = chain.then(() => onOffer(d)).catch(() => {});
  });
  // This window is done: stop looking for devices and reporting, so that nothing
  // puts "Ready" back on a window that no longer receives calls.
  const finish = () => {
    events.close();
    closePc();
    finished = true;
    timers.forEach(clearInterval);
  };
  events.addEventListener('quit', () => {
    // Stop-TailMic: end any call and close this window, so the browser exits cleanly.
    finish();
    setStatus('idle', 'TailMic stopped', 'You can close this window.');
    setTimeout(() => window.close(), 200);
  });
  events.addEventListener('replaced', () => {
    // Another TailMic window took over. Stop here instead of fighting over it.
    finish();
    setStatus('warn', 'Open in another window', 'TailMic is running in another window. You can close this one.');
  });
  events.addEventListener('hangup', (e) => {
    const d = JSON.parse(e.data);
    if (d.id === latestOfferId) latestOfferId = null; // don't start a call that was already hung up
    if (d.id !== sessionId) return;
    // 'replaced': a newer call took over; 'failed': this call never got going
    // (for example the PC answered too late); otherwise the client hung up or left.
    closePc({ replaced: 'Another client connected.', failed: 'The call could not be set up.' }[d.reason] || 'The client disconnected.');
  });
  events.addEventListener('test', (e) => {
    const d = JSON.parse(e.data);
    if (d.action === 'start') startTest(d).catch(() => {});
    else if (d.id === sessionId) stopTest();
  });
  events.addEventListener('open', () => {
    online = true;
    lastReported = '';
    report();
    // Back after the server was away: replace "TailMic server stopped" with what is true now.
    if (permOk) findDevice().catch(() => {});
  });
  events.addEventListener('error', () => {
    if (events.readyState !== EventSource.CONNECTING) return;
    online = false;
    setStatus('bad', 'TailMic server stopped', 'Reconnecting... If this stays, run Start-TailMic again on this PC.', true);
  });
}

ui.perm.addEventListener('click', async () => {
  await unlock();
  if (permOk) await findDevice();
});

(async function init() {
  // The window may open before the server is ready (e.g. after a reboot): keep trying.
  for (;;) {
    try {
      cfg = await api('/api/rconfig');
      if (cfg && Array.isArray(cfg.allowedUsers)) break;
    } catch { /* not up yet */ }
    setStatus('warn', 'Waiting for the TailMic server...', 'If this stays, run Start-TailMic on this PC.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  ui.users.textContent = cfg.allowedUsers.length ? cfg.allowedUsers.join(', ') : 'NONE - run Setup-TailMic';
  // Connect to the server first, so that `TailMic.cmd status` can say what this window is waiting for.
  connectEvents();
  await unlock();
  if (permOk) await findDevice();
  report();
  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevice().catch(() => {}));
  if (finished) return;
  timers.push(setInterval(() => stats().catch(() => {}), 1000));
  timers.push(setInterval(() => refreshDevice().catch(() => {}), 10000));
})();
