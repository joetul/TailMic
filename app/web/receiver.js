// TailMic receiver (runs in a dedicated Chrome or Edge window on the gaming PC).
// Plays the incoming WebRTC audio ONLY into "Speakers (Steam Streaming Microphone)",
// so games hear it on "Microphone (Steam Streaming Microphone)".
import { filterCandidates, selectedPair, isAllowedAddress, isAllowedEndpoint } from './sdp.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), statusText: $('statusText'), msg: $('msg'), meter: $('meter'),
  permRow: $('permRow'), perm: $('perm'), device: $('device'), users: $('users'), user: $('user'),
  route: $('route'), rtt: $('rtt'), buf: $('buf'), lost: $('lost'),
};
/** @type {HTMLAudioElement} */
const audio = $('audio');

let cfg = null;
let permOk = false;
let noInput = false; // this PC has no audio input device at all (so no Steam Streaming Microphone either)
let sinkId = null;
let sinkLabel = '';
let sinkApplied = false;
let pc = null;
let sessionId = null;
let events = null;
let lastReported = '';

window.tailmic = { stats: {} };

function setStatus(kind, text, msg = '', isErr = false) {
  ui.status.dataset.s = kind;
  ui.statusText.textContent = text;
  ui.msg.textContent = msg;
  ui.msg.classList.toggle('err', isErr);
  document.title = `TailMic (PC) - ${text}`;
  window.tailmic.status = text;
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
  const st = { deviceFound: !!(sinkId && sinkApplied), deviceLabel: sinkLabel, state: pc ? pc.connectionState : 'idle' };
  const key = JSON.stringify(st);
  if (key === lastReported) return;
  lastReported = key;
  api('/api/rstatus', st).catch(() => { lastReported = ''; });
}

// Chrome/Edge only show device names (and real IP addresses for WebRTC) to pages
// that have microphone permission, so ask once and close the mic right away.
async function unlock() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    permOk = true;
    noInput = false;
    ui.permRow.classList.add('hidden');
  } catch (e) {
    permOk = false;
    // No audio input device on this PC: nothing to allow. It also means the Steam
    // Streaming Microphone is not installed, so say that instead of asking for permission.
    noInput = e.name === 'NotFoundError';
    if (noInput) {
      ui.permRow.classList.add('hidden');
      ui.device.textContent = 'NOT FOUND (this PC has no audio input device)';
      setStatus('bad', 'Steam Streaming Microphone not found',
        'This PC has no microphone device at all, so the Steam Streaming Microphone is not installed. See "Troubleshooting" in the README.', true);
      return;
    }
    ui.permRow.classList.remove('hidden');
    setStatus('bad', 'Needs permission', 'Click "Allow" when the browser asks (one time only). TailMic uses this to find the Steam Streaming Microphone device; it does not record anything on the PC.', true);
  }
}

// Look for the output device again; if this PC had no input device before, check whether one appeared.
async function refreshDevice() {
  if (!permOk && noInput) await unlock();
  if (permOk) await findDevice();
}

async function findDevice() {
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
  if (sinkApplied && ui.status.dataset.s !== 'ok') {
    if (!pc) setStatus('ok', 'Ready', 'Waiting for your laptop to connect.');
    else if (pc.connectionState === 'connected') setStatus('ok', 'Connected', `Receiving ${ui.user.textContent}'s microphone.`);
  }
  report();
}

function closePc(reason) {
  // Tell the server this call is over, so it doesn't stay listed as active.
  if (sessionId) api('/api/ended', { id: sessionId }).catch(() => {});
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  sessionId = null;
  audio.srcObject = null;
  ui.user.textContent = ui.route.textContent = ui.rtt.textContent = ui.buf.textContent = ui.lost.textContent = '-';
  ui.meter.style.width = '0';
  if (sinkApplied) setStatus('ok', 'Ready', reason || 'Waiting for your laptop to connect.');
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
  if (d.id !== latestOfferId) return; // a newer call already arrived; this one was replaced
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
      closePc(`Blocked a connection that was not over Tailscale (${pair.local} -> ${pair.remote}).`);
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
  events.addEventListener('quit', () => {
    // Stop-TailMic: end any call and close this window, so the browser exits cleanly.
    events.close();
    closePc();
    setStatus('idle', 'TailMic stopped', 'You can close this window.');
    setTimeout(() => window.close(), 200);
  });
  events.addEventListener('replaced', () => {
    // Another TailMic window took over. Stop here instead of fighting over it.
    events.close();
    closePc();
    setStatus('warn', 'Open in another window', 'TailMic is running in another window. You can close this one.');
  });
  events.addEventListener('hangup', (e) => {
    const d = JSON.parse(e.data);
    if (d.id === latestOfferId) latestOfferId = null; // don't start a call that was already hung up
    if (d.id === sessionId) closePc(d.reason === 'replaced' ? 'Another device connected.' : 'Your laptop disconnected.');
  });
  events.addEventListener('open', () => { lastReported = ''; report(); });
  events.addEventListener('error', () => {
    if (events.readyState === EventSource.CONNECTING) setStatus('bad', 'TailMic server stopped', 'Reconnecting... If this stays, run Start-TailMic again on this PC.', true);
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
  await unlock();
  if (permOk) await findDevice();
  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevice().catch(() => {}));
  connectEvents();
  setInterval(() => stats().catch(() => {}), 1000);
  setInterval(() => refreshDevice().catch(() => {}), 10000);
})();
