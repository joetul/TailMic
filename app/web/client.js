// TailMic client (runs in Chrome, or another Chromium-based browser, on the laptop).
import { filterCandidates, mungeOpus, selectedPair, isAllowedAddress, isAllowedEndpoint } from './sdp.js';
import { TONE_HZ, peakFrequency, classifyTone } from './tone.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), statusText: $('statusText'), msg: $('msg'), meter: $('meter'),
  mic: $('mic'), permMsg: $('permMsg'), ns: $('ns'), snd: $('snd'), connect: $('connect'), mute: $('mute'),
  who: $('who'), pc: $('pc'), route: $('route'), rtt: $('rtt'), rate: $('rate'), codec: $('codec'), proc: $('proc'),
  testRec: $('testRec'), testTone: $('testTone'), testLive: $('testLive'), testMsg: $('testMsg'), monitor: $('monitor'),
};

let cfg = null;
let pc = null;
let stream = null;
let sessionId = null;
let wantConnected = false;
let retryTimer = null;
let statsTimer = null;
let discTimer = null;
let audioCtx = null;
let meterRaf = 0;
let last = null; // {bytes, packets, t}
let usingFallbackMic = false; // the chosen mic was unavailable, so the system default is in use
let micSender = null;   // sends the microphone (or, during a tone check, the test tone) to the PC
let returnTrack = null; // audio coming back from the PC: silent, except during "Test what the game hears"
let test = null;        // the running test, see runTest()

// Every connection attempt gets a number. Anything an older attempt finishes
// after you clicked Disconnect (or after a newer attempt started) is thrown
// away immediately: no mic left open, no hidden connection.
let attempt = 0;

// Exposed for automated tests / curious users (read-only use).
window.tailmic = { stats: {}, sounds: [], test: null };

function setStatus(kind, text, msg = '', isErr = false) {
  ui.status.dataset.s = kind;
  ui.statusText.textContent = text;
  ui.msg.textContent = msg;
  ui.msg.classList.toggle('err', isErr);
  document.title = `TailMic - ${text}`;
  window.tailmic.status = text;
}

// ---------- sounds ----------
// You are usually in Moonlight, not looking at this page, when the call drops.
// So a drop is announced with a few seconds of beeps, and the reconnect with a
// short chime (both can be switched off on the page).
let soundCtx = null;
let up = false;   // this call was announced as connected
let pcOk = true;  // while connected: the PC window is open and has its output device

/** Call from a click: browsers only allow a page to make sound after one. */
function armSounds() {
  try {
    if (!soundCtx) soundCtx = new AudioContext();
    if (soundCtx.state === 'suspended') soundCtx.resume().catch(() => {});
  } catch { /* sounds are optional */ }
}

/** kind: 'down' (three falling beeps, about 2.5 s) or 'up' (one short rising chime). */
function playSound(kind) {
  window.tailmic.sounds.push(kind);
  if (window.tailmic.sounds.length > 20) window.tailmic.sounds.shift(); // a short history, not a growing one
  if (!ui.snd.checked || !soundCtx) return;
  try {
    if (soundCtx.state === 'suspended') soundCtx.resume().catch(() => {});
    // Each note: [frequency in Hz, start in s, length in s]. Timed by the audio
    // clock, so it also plays correctly while this tab is in the background.
    const notes = kind === 'up'
      ? [[660, 0, 0.12], [880, 0.14, 0.2]]
      : [0, 0.9, 1.8].flatMap((t) => [[660, t, 0.22], [440, t + 0.26, 0.4]]);
    const t0 = soundCtx.currentTime + 0.05;
    for (const [freq, at, len] of notes) {
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.25, t0 + at + 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + at + len);
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.05);
    }
  } catch { /* sounds are optional */ }
}

/** The call was up and is not any more: beep once (not again for every retry). */
function announceDown() {
  if (!up) return;
  up = false;
  if (pcOk) playSound('down'); // if the PC side had already failed, the beeps were played then
  pcOk = true;
}

// While connected, ask the PC every few seconds whether it is still playing the
// microphone. The call itself stays up when Steam's device disappears on the PC,
// so without this you would not notice that the game no longer hears you.
async function watchPc() {
  let c;
  try { c = await api('/api/config?poll'); } catch { return; } // a real drop is noticed by the call itself
  if (!up) return;
  const ok = !!(c.receiverOnline && c.receiver && c.receiver.deviceFound);
  if (ok === pcOk) return;
  pcOk = ok;
  cfg = c;
  renderPc();
  if (ok) {
    playSound('up');
    onConnState();
  } else {
    playSound('down');
    setStatus('warn', 'Connected, but the game cannot hear you',
      c.receiverOnline ? 'The PC lost "Speakers (Steam Streaming Microphone)". Is Steam still running on the PC?' : 'The TailMic window on the PC was closed. Start TailMic on the PC again.');
  }
}

class TailMicError extends Error {
  constructor(message, code, retry = true) { super(message); this.code = code; this.retry = retry; }
}
class Abandoned extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(path, {
      method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new TailMicError('Cannot reach the PC. Is Tailscale connected and is the PC on?', 'network');
  }
  let j = {};
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok) {
    const code = j.error || `http_${r.status}`;
    // 403 = not allowed; 409 = another device took over. Retrying would not help.
    const retry = r.status !== 403 && code !== 'replaced';
    const msg = code === 'replaced' ? 'Another device took over the TailMic microphone.' : (j.message || j.error || `HTTP ${r.status}`);
    throw new TailMicError(msg, code, retry);
  }
  return j;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// Echo cancellation and auto gain stay off (Chrome cannot cancel Moonlight's game
// audio anyway, and auto gain "pumps" room noise). Noise suppression is the
// user's choice (checkbox, on by default).
function micConstraints(deviceId) {
  const a = {
    echoCancellation: false,
    noiseSuppression: ui.ns.checked,
    autoGainControl: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };
  const sup = navigator.mediaDevices.getSupportedConstraints?.() || {};
  if (sup.voiceIsolation) a.voiceIsolation = false;
  if (deviceId) a.deviceId = { exact: deviceId };
  return { audio: a, video: false };
}

/** Open the chosen mic; if it is gone, fall back to the system default. */
async function openMic() {
  const wanted = ui.mic.value;
  try {
    const s = await navigator.mediaDevices.getUserMedia(micConstraints(wanted));
    usingFallbackMic = false;
    return s;
  } catch (e) {
    if (wanted && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError')) {
      const s = await navigator.mediaDevices.getUserMedia(micConstraints(''));
      usingFallbackMic = true;
      return s;
    }
    if (e.name === 'NotAllowedError') {
      throw new TailMicError('Microphone access was blocked. Click the icon at the left of the address bar and allow the microphone.', 'mic_denied', false);
    }
    throw new TailMicError(`Could not open the microphone: ${e.message}`, 'mic_error', false);
  }
}

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const saved = store.get('tailmic.mic') || '';
  const current = ui.mic.value || saved;
  ui.mic.replaceChildren(new Option('System default', ''));
  let labelled = false;
  for (const d of mics) {
    if (d.label) labelled = true;
    ui.mic.add(new Option(d.label || 'Microphone', d.deviceId));
  }
  if ([...ui.mic.options].some((o) => o.value === current)) ui.mic.value = current;
  ui.permMsg.classList.toggle('hidden', labelled);
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

function startMeter() {
  stopMeter();
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const db = 20 * Math.log10(peak || 1e-6);
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      ui.meter.style.width = `${pct}%`;
      window.tailmic.stats.micPeakDb = Math.round(db);
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* meter is optional */ }
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  ui.meter.style.width = '0';
  audioCtx?.close().catch(() => {});
  audioCtx = null;
}

function stopStream(s) {
  s?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
}

function cleanup() {
  abortTest();
  micSender = null;
  returnTrack = null;
  clearInterval(statsTimer); statsTimer = null;
  clearTimeout(discTimer); discTimer = null;
  stopMeter();
  if (pc) { pc.onconnectionstatechange = null; pc.ontrack = null; pc.close(); pc = null; }
  stopStream(stream);
  stream = null;
  last = null;
  ui.route.textContent = ui.rtt.textContent = ui.rate.textContent = ui.codec.textContent = ui.proc.textContent = '-';
  ui.mute.disabled = true;
  ui.mute.setAttribute('aria-pressed', 'false');
  ui.mute.textContent = 'Mute';
  renderTest();
}

function scheduleRetry(why) {
  clearTimeout(retryTimer);
  if (!wantConnected) return;
  setStatus('warn', 'Reconnecting...', why);
  retryTimer = setTimeout(() => { if (wantConnected) connect(); }, 3000);
}

async function connect() {
  const my = ++attempt;
  const check = () => { if (my !== attempt || !wantConnected) throw new Abandoned(); };
  clearTimeout(retryTimer);
  cleanup();
  wantConnected = true;
  ui.connect.textContent = 'Disconnect';
  ui.connect.classList.remove('primary');
  setStatus('warn', 'Connecting...');
  let myStream = null;
  let myPc = null;
  try {
    const c = await api('/api/config');
    check();
    cfg = c;
    renderPc();
    if (!cfg.receiverOnline) throw new TailMicError('TailMic is not running on the PC. Double-click Start-TailMic on the PC.', 'receiver_offline');
    // Don't open the mic just to be refused: wait for the PC's Steam device first.
    if (!cfg.receiver || !cfg.receiver.deviceFound) {
      throw new TailMicError('The PC cannot find "Speakers (Steam Streaming Microphone)" yet. Is Steam running on the PC?', 'no_output_device');
    }

    myStream = await openMic();
    check();
    stream = myStream;
    await listMics();
    check();
    const track = stream.getAudioTracks()[0];
    prepareTrack(track);

    myPc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    pc = myPc;
    // 'sendrecv': the way back stays silent until you run "Test what the game hears".
    const tr = myPc.addTransceiver(track, { direction: 'sendrecv', streams: [stream] });
    micSender = tr.sender;
    myPc.ontrack = (ev) => { if (pc === myPc) { returnTrack = ev.track; renderTest(); } };
    try {
      const caps = RTCRtpReceiver.getCapabilities('audio');
      const opus = caps.codecs.filter((x) => x.mimeType.toLowerCase() === 'audio/opus');
      if (opus.length && tr.setCodecPreferences) tr.setCodecPreferences(opus);
    } catch { /* fine: Opus is Chrome's default anyway */ }
    myPc.onconnectionstatechange = onConnState;

    await myPc.setLocalDescription(await myPc.createOffer());
    check();
    await waitForIce(myPc, 3000);
    check();
    const f = filterCandidates(myPc.localDescription.sdp, cfg.allowedCidrs);
    if (!f.kept.length) {
      throw new TailMicError('The browser on this computer found no Tailscale address. Make sure Tailscale is connected, then try again.', 'no_tailscale_candidates');
    }
    const ans = await api('/api/offer', { method: 'POST', body: { sdp: mungeOpus(f.sdp, cfg.opus) } });
    if (my !== attempt || !wantConnected) {
      // We were cancelled while the PC was answering: tell it to hang up.
      api('/api/hangup', { method: 'POST', body: { id: ans.id } }).catch(() => {});
      throw new Abandoned();
    }
    sessionId = ans.id;
    // The answer tells *us* how to encode: mono Opus, FEC, no DTX, 10 ms, high bitrate.
    await myPc.setRemoteDescription({ type: 'answer', sdp: mungeOpus(ans.sdp, cfg.opus) });
    check();

    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = cfg.opus.maxaveragebitrate;
    p.encodings[0].priority = 'high';
    p.encodings[0].networkPriority = 'high';
    await tr.sender.setParameters(p).catch(() => {});
    check();

    startMeter();
    statsTimer = setInterval(stats, 1000);
    ui.mute.disabled = false;
    if (usingFallbackMic) setStatus('warn', 'Connecting...', 'Your chosen microphone is not available, so the system default is used.');
  } catch (e) {
    if (e instanceof Abandoned) {
      // Only release what this attempt opened; a newer attempt owns the globals.
      if (myPc && pc !== myPc) { myPc.onconnectionstatechange = null; myPc.ontrack = null; myPc.close(); }
      if (myStream && stream !== myStream) stopStream(myStream);
      if (my === attempt) cleanup(); // cancelled by Disconnect
      return;
    }
    if (my !== attempt) return;
    cleanup();
    announceDown(); // e.g. a reconnect after a failed microphone switch did not work
    const err = e instanceof TailMicError ? e : new TailMicError(e.message || String(e), 'error');
    if (err.retry && wantConnected) {
      scheduleRetry(err.message);
    } else {
      stop(false);
      setStatus(err.code === 'replaced' ? 'warn' : 'bad', 'Not connected', err.message, err.code !== 'replaced');
    }
  }
}

function onConnState() {
  if (!pc) return;
  const st = pc.connectionState;
  renderTest();
  if (st === 'connected') {
    clearTimeout(discTimer);
    if (!up) { up = true; pcOk = true; playSound('up'); }
    const msg = usingFallbackMic
      ? 'Connected using the system default microphone (your chosen one is not available).'
      : 'The PC now hears this microphone as "Microphone (Steam Streaming Microphone)".';
    setStatus('ok', ui.mute.getAttribute('aria-pressed') === 'true' ? 'Connected (muted)' : 'Connected', msg);
  } else if (st === 'disconnected') {
    setStatus('warn', 'Connection interrupted...');
    clearTimeout(discTimer);
    discTimer = setTimeout(() => { if (pc && pc.connectionState !== 'connected') lost(); }, 4000);
  } else if (st === 'failed' || st === 'closed') {
    lost();
  }
}

async function lost() {
  const mine = sessionId;
  const my = ++attempt; // stop anything else in flight
  cleanup();
  announceDown();
  if (!wantConnected) return;
  try {
    const c = await api('/api/config');
    if (my !== attempt || !wantConnected) return;
    if (c.activeSession && c.activeSession !== mine) {
      stop(false);
      setStatus('warn', 'Not connected', 'Another device took over the TailMic microphone.');
      return;
    }
  } catch { /* retry below */ }
  if (my === attempt) scheduleRetry('Connection lost. Trying again...');
}

async function stats() {
  const peer = pc;
  if (!peer) return;
  const report = await peer.getStats();
  if (peer !== pc) return;
  const pair = selectedPair(report);
  if (pair && pair.local && pair.remote) {
    // Our end must be a Tailscale address; the PC's end must be one of the PC's own Tailscale IPs.
    if (!isAllowedAddress(pair.local, cfg.allowedCidrs) || !isAllowedEndpoint(pair.remote, cfg.allowedCidrs, cfg.pcIps)) {
      announceDown();
      stop(true);
      setStatus('bad', 'Blocked', `Connection was not over Tailscale (${pair.local} -> ${pair.remote}), so it was closed.`, true);
      return;
    }
    ui.route.textContent = `${pair.local} → ${pair.remote} (Tailscale)`;
    if (pair.rtt !== undefined) ui.rtt.textContent = `${Math.round(pair.rtt * 1000)} ms`;
  }
  let out = null;
  report.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'audio') out = s; });
  if (out) {
    const now = out.timestamp;
    if (last) {
      const kbps = ((out.bytesSent - last.bytes) * 8) / (now - last.t);
      const pps = ((out.packetsSent - last.packets) * 1000) / (now - last.t);
      ui.rate.textContent = `${Math.round(kbps)} kbit/s, ${Math.round(pps)} packets/s`;
      window.tailmic.stats.kbps = kbps;
      window.tailmic.stats.pps = pps;
    }
    last = { bytes: out.bytesSent, packets: out.packetsSent, t: now };
    const codec = out.codecId && report.get(out.codecId);
    if (codec) {
      ui.codec.textContent = `${codec.mimeType.replace('audio/', '')} ${codec.clockRate / 1000} kHz ${codec.sdpFmtpLine?.includes('stereo=1') ? 'stereo' : 'mono'}`;
      window.tailmic.stats.codec = { mimeType: codec.mimeType, fmtp: codec.sdpFmtpLine };
    }
    window.tailmic.stats.bytesSent = out.bytesSent;
    window.tailmic.stats.packetsSent = out.packetsSent;
    window.tailmic.stats.t = now;
  }
  window.tailmic.stats.connectionState = peer.connectionState;
  window.tailmic.stats.route = pair;
}

function stop(sendHangup) {
  attempt++; // cancels any connect/switch still in progress
  wantConnected = false;
  up = false; // you disconnected yourself (or were already told): no beeps
  pcOk = true;
  clearTimeout(retryTimer);
  if (sendHangup && sessionId) api('/api/hangup', { method: 'POST', body: { id: sessionId } }).catch(() => {});
  sessionId = null;
  cleanup();
  ui.connect.textContent = 'Connect';
  ui.connect.classList.add('primary');
  setStatus('idle', 'Not connected');
}

// ---------- "Test what the game hears" ----------
// The PC sends back, over the same connection, what a game gets from
// "Microphone (Steam Streaming Microphone)". Three ways to use it:
//   rec  - record 5 seconds, then play them back (no feedback loop)
//   tone - send a steady tone instead of the microphone and measure the pitch
//          that comes back: a wrong pitch means the Steam device is set up wrong
//   live - hear it continuously (headphones needed)
// The PC only listens while a test runs; it stops by itself after 30 seconds.
const TEST_RECORD_S = 5;
const FORMAT_FIX = 'Fix on the PC: Settings → System → Sound → More sound settings → Recording tab → "Microphone (Steam Streaming Microphone)" → Properties → Advanced. '
  + 'Set Default Format to exactly what "TailMic.cmd status" prints for the Speakers half, for example "2 channel, 32 bit, 48000 Hz" (channels, bits and Hz must all match). Then restart TailMic and the game.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A finished test's note ("That is what the game hears...", "Tone check passed...")
// makes way for the usual hint after this long. A problem (red) stays until the
// next test: it often comes with steps to follow on the PC.
const TEST_NOTE_MS = 15000;
let testNoteTimer = 0;

function setTestMsg(text, kind = '') {
  clearTimeout(testNoteTimer);
  ui.testMsg.textContent = text;
  ui.testMsg.classList.toggle('err', kind === 'bad');
  ui.testMsg.classList.toggle('good', kind === 'ok');
}

const canTest = () => !!(pc && pc.connectionState === 'connected' && returnTrack && sessionId);

/** What the test card says when no test runs and there is no result to show. */
const idleTestMsg = () => (canTest()
  ? 'Ready. "Tone check" tells you in a few seconds whether speed and pitch are right.'
  : 'Connect first.');

function renderTest() {
  const can = canTest();
  const live = !!test && test.kind === 'live';
  ui.testRec.disabled = ui.testTone.disabled = !can || !!test;
  ui.testLive.disabled = !can || (!!test && !live);
  ui.testLive.setAttribute('aria-pressed', String(live));
  ui.testLive.textContent = live ? 'Stop listening' : 'Listen live';
  // A tone check sends the tone in place of the microphone, so don't switch microphones meanwhile.
  ui.mic.disabled = ui.ns.disabled = !!test && test.kind === 'tone';
  if (!can && !test && !ui.testMsg.classList.contains('err') && !ui.testMsg.classList.contains('good')) setTestMsg('Connect first.');
  else if (can && !test && ui.testMsg.textContent === 'Connect first.') setTestMsg(idleTestMsg());
}

/** What a tone check result means, in plain words. Returns [text, 'ok' | 'bad']. */
function toneMessage({ verdict, hz }) {
  const came = `The ${TONE_HZ} Hz test tone came back as ${hz} Hz`;
  switch (verdict) {
    case 'ok':
      return [`Tone check passed: the game hears the right speed and pitch (${hz} Hz for a ${TONE_HZ} Hz tone).`, 'ok'];
    case 'half':
      return [`${came}: the game hears you at HALF speed, slow and deep. The two halves of the Steam Streaming Microphone use a different number of channels (Speakers 2 channel, Microphone 1 channel). ${FORMAT_FIX}`, 'bad'];
    case 'double':
      return [`${came}: the game hears you at DOUBLE speed, fast and high. The two halves of the Steam Streaming Microphone use a different number of channels (Speakers 1 channel, Microphone 2 channel). ${FORMAT_FIX}`, 'bad'];
    case 'rate_low':
      return [`${came}: the game hears you about 8% too slow and low, with crackle. The two halves of the Steam Streaming Microphone use different sample rates (Speakers 48000 Hz, Microphone 44100 Hz). ${FORMAT_FIX}`, 'bad'];
    case 'rate_high':
      return [`${came}: the game hears you about 9% too fast and high, with crackle. The two halves of the Steam Streaming Microphone use different sample rates (Speakers 44100 Hz, Microphone 48000 Hz). ${FORMAT_FIX}`, 'bad'];
    case 'silent':
      return ['Nothing came back: the PC plays your sound, but "Microphone (Steam Streaming Microphone)" stays silent. On the PC, check under Settings → System → Sound that both Steam Streaming Microphone devices are enabled and not muted, then run "TailMic.cmd status".', 'bad'];
    default:
      return [`${came}, which is wrong: the game does not hear you correctly. The two halves of the Steam Streaming Microphone probably use different formats. ${FORMAT_FIX}`, 'bad'];
  }
}

/** Tell the PC to stop listening (once per test). */
function stopPcCapture(t) {
  if (t.pcStopped) return Promise.resolve();
  t.pcStopped = true;
  if (!sessionId || sessionId !== t.id) return Promise.resolve(); // the call is gone, and the PC stopped with it
  return api('/api/test', { method: 'POST', body: { id: t.id, action: 'stop' } }).catch(() => {});
}

/** End the running test from outside (call dropped, Disconnect clicked). */
function abortTest() {
  if (!test) return;
  test.aborted = true;
  test.stop?.();
}

async function testRecord(t, back) {
  const rec = new MediaRecorder(back);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  t.cleanup.push(() => { if (rec.state !== 'inactive') rec.stop(); });
  rec.start();
  for (let left = TEST_RECORD_S; left > 0; left--) {
    setTestMsg(`Recording what the game hears. Talk now... ${left}`);
    await sleep(1000);
    t.check();
  }
  rec.stop();
  await stopped;
  await stopPcCapture(t);
  // Kept in memory only, and gone when it has been played.
  let buf;
  try {
    buf = await soundCtx.decodeAudioData(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer());
  } catch {
    throw new TailMicError('The recording came out empty or unreadable. Try again.', 'bad_recording');
  }
  t.check();
  let peak = 0;
  for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
  window.tailmic.test = { kind: 'rec', seconds: buf.duration, peak };
  if (peak < 0.002) {
    const muted = ui.mute.getAttribute('aria-pressed') === 'true';
    setTestMsg(muted ? 'The recording is silent, because you are muted. Click Unmute and try again.'
      : 'The recording is silent: nothing reached "Microphone (Steam Streaming Microphone)" on the PC. Does the meter above move when you talk? If it does, run "Tone check".', 'bad');
    return;
  }
  setTestMsg('Playing back what the game heard...');
  const src = soundCtx.createBufferSource();
  src.buffer = buf;
  src.connect(soundCtx.destination);
  const ended = new Promise((r) => { src.onended = r; t.stop = r; });
  t.cleanup.push(() => { try { src.stop(); } catch { /* already stopped */ } });
  src.start();
  await ended;
  t.check();
  setTestMsg('That is what the game hears. If your voice was slow, deep or distorted, run "Tone check" to find out why.', 'ok');
}

async function testTone(t, back) {
  const sender = micSender;
  const osc = soundCtx.createOscillator();
  const gain = soundCtx.createGain();
  const out = soundCtx.createMediaStreamDestination();
  osc.frequency.value = TONE_HZ;
  gain.gain.value = 0.25;
  osc.connect(gain).connect(out);
  const src = soundCtx.createMediaStreamSource(back);
  const an = soundCtx.createAnalyser();
  an.fftSize = 16384; // about 3 Hz per step at 48 kHz
  an.smoothingTimeConstant = 0;
  src.connect(an);
  t.cleanup.push(() => {
    // Put the microphone back (whichever is current, muted or not).
    if (micSender === sender) sender.replaceTrack(stream ? stream.getAudioTracks()[0] || null : null).catch(() => {});
    try { osc.stop(); } catch { /* not started */ }
    src.disconnect();
    out.stream.getTracks().forEach((x) => x.stop());
  });
  osc.start();
  await sender.replaceTrack(out.stream.getAudioTracks()[0]);
  t.check();
  setTestMsg('Sending a test tone through the PC. The game hears a beep for about 3 seconds...');
  await sleep(1200); // let the tone travel to the PC and back
  const spectrum = new Float32Array(an.frequencyBinCount);
  const seen = [];
  for (let i = 0; i < 20; i++) {
    t.check();
    an.getFloatFrequencyData(spectrum);
    seen.push(peakFrequency(spectrum, soundCtx.sampleRate, an.fftSize));
    await sleep(100);
  }
  t.check();
  const result = classifyTone(seen);
  window.tailmic.test = { kind: 'tone', ...result };
  setTestMsg(...toneMessage(result));
}

async function testLive(t) {
  ui.monitor.muted = false;
  setTestMsg('Live: you hear what the game hears, a moment later. Use headphones, or it will echo. Click "Stop listening" when you are done.');
  // The PC stops listening by itself after 30 seconds; ask for more time while this runs.
  const renew = setInterval(() => {
    api('/api/test', { method: 'POST', body: { id: t.id, action: 'start' } }).catch(() => t.stop?.());
  }, 15000);
  t.cleanup.push(() => clearInterval(renew));
  await new Promise((r) => { t.stop = r; });
  t.check();
  setTestMsg('Stopped listening.');
}

async function runTest(kind) {
  if (test) {
    if (test.kind === 'live' && kind === 'live') test.stop?.(); // "Stop listening"
    return;
  }
  armSounds();
  if (!pc || pc.connectionState !== 'connected' || !returnTrack || !sessionId) return;
  const t = { kind, id: sessionId, aborted: false, pcStopped: false, cleanup: [], stop: null };
  t.check = () => { if (t.aborted || test !== t) throw new Abandoned(); };
  test = t;
  window.tailmic.test = null;
  renderTest();
  try {
    if (!soundCtx) throw new TailMicError('This browser cannot play sound on this page.', 'no_audio');
    setTestMsg('Asking the PC to listen to "Microphone (Steam Streaming Microphone)"...');
    await api('/api/test', { method: 'POST', body: { id: t.id, action: 'start' } });
    t.check();
    const back = new MediaStream([returnTrack]);
    // Attached to a (silent) player as well: Chrome only delivers incoming call audio to a page that plays it.
    ui.monitor.muted = true;
    ui.monitor.srcObject = back;
    await ui.monitor.play().catch(() => {});
    t.check();
    if (kind === 'rec') await testRecord(t, back);
    else if (kind === 'tone') await testTone(t, back);
    else await testLive(t);
  } catch (e) {
    if (e instanceof Abandoned) setTestMsg('The test was stopped.');
    else setTestMsg(e.message || String(e), 'bad');
  } finally {
    for (const f of t.cleanup.reverse()) { try { f(); } catch { /* keep cleaning up */ } }
    ui.monitor.pause();
    ui.monitor.srcObject = null;
    stopPcCapture(t);
    if (test === t) test = null;
    renderTest();
    if (!test && !ui.testMsg.classList.contains('err')) {
      testNoteTimer = setTimeout(() => {
        if (!test && ui.testMsg.textContent !== idleTestMsg()) setTestMsg(idleTestMsg());
      }, TEST_NOTE_MS);
    }
  }
}

ui.testRec.addEventListener('click', () => runTest('rec'));
ui.testTone.addEventListener('click', () => runTest('tone'));
ui.testLive.addEventListener('click', () => runTest('live'));

function renderPc() {
  if (!cfg) return;
  ui.who.textContent = `Signed in to Tailscale as ${cfg.user}`;
  const r = cfg.receiver || {};
  if (!cfg.receiverOnline) ui.pc.textContent = 'TailMic not running on the PC';
  else if (!r.deviceFound) ui.pc.textContent = 'Running, but "Steam Streaming Microphone" not found (is Steam running?)';
  else ui.pc.textContent = `Ready - output: ${r.deviceLabel}`;
}

ui.connect.addEventListener('click', () => {
  armSounds();
  if (wantConnected) stop(true);
  else connect();
});

ui.mute.addEventListener('click', () => {
  const t = stream?.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  ui.mute.setAttribute('aria-pressed', String(!t.enabled));
  ui.mute.textContent = t.enabled ? 'Mute' : 'Unmute';
  if (pc?.connectionState === 'connected') setStatus('ok', t.enabled ? 'Connected' : 'Connected (muted)', ui.msg.textContent);
});

function prepareTrack(track) {
  track.contentHint = ui.ns.checked ? 'speech' : 'music';
  // A USB mic that is unplugged ends its track: warn and switch to another mic.
  track.onended = () => {
    if (!wantConnected || !stream || !stream.getAudioTracks().includes(track)) return;
    setStatus('warn', 'Microphone disconnected', 'Switching to another microphone...');
    switchInput();
  };
  const s = track.getSettings();
  ui.proc.textContent = `noise suppression ${s.noiseSuppression ? 'ON' : 'off'}, echo cancel ${s.echoCancellation ? 'ON' : 'off'}, auto gain ${s.autoGainControl ? 'ON' : 'off'}`;
  window.tailmic.stats.trackSettings = s;
}

// Switch microphone or noise suppression while connected, without hanging up:
// open the mic again with the new settings and swap the track being sent.
let switching = false;
let switchAgain = false;
async function switchInput() {
  if (!wantConnected) return;
  if (switching) { switchAgain = true; return; } // run once more when the current switch ends
  const sender = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
  if (!sender || !stream || pc.connectionState !== 'connected') { connect(); return; } // still connecting: start over with the new choice
  switching = true;
  const my = attempt;
  const wasEnabled = stream.getAudioTracks()[0]?.enabled !== false;
  let next = null;
  try {
    // Close the old mic first: browsers may refuse two different processing
    // settings on the same device at once.
    stopMeter();
    stopStream(stream);
    next = await openMic();
    if (my !== attempt || !wantConnected) { stopStream(next); return; }
    const t = next.getAudioTracks()[0];
    t.enabled = wasEnabled;
    prepareTrack(t);
    await sender.replaceTrack(t);
    if (my !== attempt || !wantConnected) { stopStream(next); return; }
    stream = next;
    startMeter();
    if (pc?.connectionState === 'connected') onConnState();
  } catch {
    // Never leave the new mic open when the switch failed (e.g. the call dropped meanwhile).
    if (next && next !== stream) stopStream(next);
    if (my === attempt && wantConnected) connect(); // fall back to a full reconnect
  } finally {
    switching = false;
    if (switchAgain) { switchAgain = false; switchInput(); }
  }
}

ui.mic.addEventListener('change', () => {
  store.set('tailmic.mic', ui.mic.value);
  switchInput();
});

ui.ns.addEventListener('change', () => {
  store.set('tailmic.ns', ui.ns.checked ? '1' : '0');
  switchInput();
});

ui.snd.addEventListener('change', () => {
  store.set('tailmic.snd', ui.snd.checked ? '1' : '0');
  armSounds();
});

navigator.mediaDevices.addEventListener('devicechange', async () => {
  try { await listMics(); } catch { return; }
  // The chosen mic came back (e.g. USB re-plugged): switch back to it.
  if (wantConnected && usingFallbackMic && ui.mic.value) switchInput();
});
window.addEventListener('pagehide', () => {
  if (sessionId) {
    navigator.sendBeacon('/api/hangup', new Blob([JSON.stringify({ id: sessionId })], { type: 'application/json' }));
  }
});

(async function init() {
  ui.ns.checked = store.get('tailmic.ns') !== '0'; // on unless you turned it off
  ui.snd.checked = store.get('tailmic.snd') !== '0'; // on unless you turned it off
  if (!window.isSecureContext || !navigator.mediaDevices) {
    setStatus('bad', 'Wrong address', 'Open TailMic using its https://...ts.net address.', true);
    return;
  }
  await listMics().catch(() => {});
  try {
    cfg = await api('/api/config');
    renderPc();
    ui.connect.disabled = false;
    setStatus('idle', 'Not connected', cfg.receiverOnline ? 'Pick your microphone and click Connect.' : 'TailMic is not running on the PC yet.');
  } catch (e) {
    setStatus('bad', 'Not allowed', e.message, true);
    if (e.retry) { ui.connect.disabled = false; }
  }
  // Keep the "PC" line current. Not while this tab is hidden with nothing
  // connected: then nobody is looking, and the PC is left alone.
  const lookAtPc = async () => {
    try { cfg = await api('/api/config?poll'); renderPc(); } catch { /* ignore */ }
  };
  setInterval(() => {
    if (wantConnected) { if (up) watchPc(); return; }
    if (!document.hidden) lookAtPc();
  }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !wantConnected) lookAtPc(); });
})();
