// End-to-end test: real Chromium on both ends (fake mic), real TailMic server.
// Run inside the Playwright Docker image (see README "For developers").
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

const ROOT = process.env.TAILMIC_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const USER = 'test@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailmic-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const p = spawn(process.execPath, [path.join(ROOT, 'app/server.js'), '--config', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  p.stdout.on('data', (d) => logs.push(String(d)));
  p.stderr.on('data', (d) => logs.push(String(d)));
  return { p, logs, stop: () => p.kill() };
}

async function waitFor(page, fn, arg, timeout = 15000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 200 });
}

// Test probes injected into every page: record every mic stream and every
// peer connection, optionally delay getUserMedia, optionally hide audio outputs.
const PROBES = () => {
  window.__streams = [];
  window.__pcs = [];
  const md = navigator.mediaDevices;
  if (md) {
    const gum = md.getUserMedia.bind(md);
    // Stand-in for Steam's device, which headless Chromium does not have: what is
    // played into the "Speakers" half comes out of the "Microphone" half. With
    // window.__loop = 1 it comes out unchanged; 0.5 plays it at half speed (what a
    // 2-channel/1-channel mismatch does), 44100/48000 slightly slow (a sample-rate
    // mismatch), and 0 gives silence.
    const loopback = async (deviceId) => {
      const dev = (await md.enumerateDevices()).find((d) => d.deviceId === deviceId);
      const speed = window.__loop;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(document.getElementById('audio').srcObject);
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      const ring = new Float32Array(ctx.sampleRate * 60);
      let w = 0;
      let r = 0;
      sp.onaudioprocess = (e) => {
        const inp = e.inputBuffer.getChannelData(0);
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < inp.length; i++) ring[w++ % ring.length] = inp[i];
        for (let i = 0; i < out.length; i++) {
          const k = Math.floor(r);
          if (speed > 0 && k + 1 < w) {
            out[i] = ring[k % ring.length] * (1 - (r - k)) + ring[(k + 1) % ring.length] * (r - k);
            r += speed;
          } else out[i] = 0;
        }
      };
      const dst = ctx.createMediaStreamDestination();
      const quiet = ctx.createGain();
      quiet.gain.value = 0;
      src.connect(sp);
      sp.connect(dst);
      sp.connect(quiet).connect(ctx.destination); // keeps the processor running
      Object.defineProperty(dst.stream.getAudioTracks()[0], 'label', { value: dev ? dev.label : '' });
      return dst.stream;
    };
    md.getUserMedia = async (c) => {
      if (window.__gumDelay) await new Promise((r) => setTimeout(r, window.__gumDelay));
      const viaLoop = window.__loop !== undefined && c && c.audio && c.audio.deviceId;
      const st = viaLoop ? await loopback(c.audio.deviceId.exact) : await gum(c);
      const asked = c && c.audio && c.audio.deviceId && c.audio.deviceId.exact;
      if (asked && !viaLoop && (await md.enumerateDevices()).some((d) => d.deviceId === asked && d.label === STEAM_MIC)) {
        Object.defineProperty(st.getAudioTracks()[0], 'label', { value: STEAM_MIC });
      }
      window.__streams.push(st);
      return st;
    };
    // With window.__steamMic, one of Chromium's fake microphones carries the name of
    // Steam's (the page finds that device by name, and the name is not a setting).
    const STEAM_MIC = 'Microphone (Steam Streaming Microphone)';
    const poses = (d) => window.__steamMic && d.kind === 'audioinput' && d.label === 'Fake Audio Input 1';
    const enumerate = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => (await enumerate())
      .filter((d) => !(window.__hideOutputs && d.kind === 'audiooutput'))
      .map((d) => (poses(d) ? { deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: STEAM_MIC } : d));
  }
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Orig { constructor(...a) { super(...a); window.__pcs.push(this); } };
  window.__liveTracks = () => window.__streams.flatMap((x) => x.getTracks()).filter((t) => t.readyState === 'live').length;
  window.__openPcs = () => window.__pcs.filter((x) => x.connectionState !== 'closed' && x.signalingState !== 'closed').length;
};

// The file Start-TailMic writes into the TailMic-only browser profile on the PC: it
// allows ONE site (TailMic's own page) to use audio devices without asking.
const profileSeed = (origin) => fs.readFileSync(path.join(ROOT, 'scripts/receiver-preferences.json'), 'utf8').trim().replace('{ORIGIN}', origin);

// realProfile: run the PC window the way Start-TailMic does - its own browser
// profile, prepared for `realProfile(cfg)` (a site), no switch that accepts every
// permission request, and the page's real security policy.
// steamMic: the PC has a "Microphone (Steam Streaming Microphone)" (see the probes).
async function run(name, cfgOverrides, body, { beforeReceiver, realProfile, steamMic } = {}) {
  const cfg = { clientPort: 18470, receiverPort: 18471, allowedUsers: [USER], ...cfgOverrides };
  const srv = startServer(cfg);
  await sleep(500);
  const browser = await chromium.launch({
    channel: 'chromium', // full Chromium in new headless mode
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  let rctx = null;
  try {
    if (realProfile) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailmic-profile-'));
      fs.mkdirSync(path.join(dir, 'Default'));
      fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), profileSeed(realProfile(cfg)));
      rctx = await chromium.launchPersistentContext(dir, {
        channel: 'chromium',
        args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
      });
    } else {
      rctx = await browser.newContext({ bypassCSP: true }); // lets the test runner evaluate its probes
      await rctx.grantPermissions(['microphone']);
    }
    await rctx.addInitScript(PROBES);
    if (steamMic) await rctx.addInitScript(() => { window.__steamMic = true; });
    if (beforeReceiver) await beforeReceiver(rctx);
    const receiver = await rctx.newPage();
    receiver.on('console', (m) => m.type() === 'error' && console.log('[receiver]', m.text()));
    await receiver.goto(`http://127.0.0.1:${cfg.receiverPort}/`);

    const cctx = await browser.newContext({ bypassCSP: true, extraHTTPHeaders: { 'Tailscale-User-Login': USER } });
    await cctx.grantPermissions(['microphone']);
    await cctx.addInitScript(PROBES);
    const client = await cctx.newPage();
    client.on('console', (m) => m.type() === 'error' && console.log('[client]', m.text()));
    await client.goto(`http://127.0.0.1:${cfg.clientPort}/`);
    await body({ receiver, client, srv, cfg, rctx });
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n`, e);
    console.log('--- server log ---\n' + srv.logs.join(''));
    process.exitCode = 1;
  } finally {
    if (realProfile) await rctx?.close();
    await browser.close();
    srv.stop();
    await sleep(300);
  }
}

// Headless Chromium has no Steam device; its fake outputs stand in for it.
const FAKE_OUTPUT = 'Fake Audio Output';
// The test container is not on Tailscale: allow its private ranges for the positive test only.
const LAB_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

await run('audio flows end to end (Opus mono 10 ms), processing off, then noise suppression switched on live', {
  allowedCidrs: LAB_CIDRS,
  outputDeviceMatch: FAKE_OUTPUT,
}, async ({ receiver, client }) => {
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
  await waitFor(client, () => !document.getElementById('connect').disabled);
  assert.equal(await client.isChecked('#ns'), true, 'noise suppression is on by default');
  await client.uncheck('#ns'); // test the pure, unprocessed mode first
  await client.click('#connect');
  await waitFor(client, () => window.tailmic.stats.connectionState === 'connected');
  await waitFor(receiver, () => (window.tailmic.stats.packetsReceived || 0) > 50);
  await sleep(1500);
  // The page works out packets/s once a second. Its counters can lag for a moment and then
  // catch up (one reading of 70, the next of 130), so take the middle one of several readings.
  const readings = [];
  for (let i = 0; i < 7; i++) { await sleep(1000); readings.push(await client.evaluate(() => window.tailmic.stats.pps || 0)); }
  const avgPps = readings.sort((x, y) => x - y)[3];
  let maxLevel = 0;
  for (let i = 0; i < 8; i++) {
    maxLevel = Math.max(maxLevel, await receiver.evaluate(() => window.tailmic.stats.audioLevel || 0));
    await sleep(250);
  }
  const c = await client.evaluate(() => window.tailmic.stats);
  const r = await receiver.evaluate(() => window.tailmic.stats);
  console.log('client stats:', JSON.stringify({ avgPps, kbps: c.kbps, codec: c.codec, route: c.route, settings: c.trackSettings }));
  console.log('receiver stats:', JSON.stringify({ ...r, maxLevel }));
  console.log('client status:', await client.textContent('#statusText'), '|', await client.textContent('#route'));
  console.log('receiver status:', await receiver.textContent('#statusText'), '|', await receiver.textContent('#device'));

  assert.equal(c.codec.mimeType.toLowerCase(), 'audio/opus');
  assert.match(c.codec.fmtp, /stereo=0/);
  assert.match(c.codec.fmtp, /useinbandfec=1/);
  assert.match(c.codec.fmtp, /usedtx=0/);
  assert.ok(avgPps > 85 && avgPps < 115, `expected ~100 packets/s (10 ms frames), got ${avgPps}`);
  assert.equal(c.trackSettings.echoCancellation, false);
  assert.equal(c.trackSettings.noiseSuppression, false);
  assert.equal(c.trackSettings.autoGainControl, false);
  assert.ok(r.bytesReceived > 10000, 'receiver got audio bytes');
  assert.ok(maxLevel > 0, 'receiver decoded non-silent audio');
  assert.ok(r.sinkLabel.includes(FAKE_OUTPUT), 'played only into the configured output device');

  // Turn noise suppression on while connected: the call must stay up and keep sending.
  const before = await receiver.evaluate(() => window.tailmic.stats.packetsReceived);
  await client.check('#ns');
  await waitFor(client, () => window.tailmic.stats.trackSettings && window.tailmic.stats.trackSettings.noiseSuppression === true);
  await sleep(2000);
  const after = await receiver.evaluate(() => window.tailmic.stats);
  const proc = await client.textContent('#proc');
  console.log('after enabling noise suppression:', proc, '| packets', before, '->', after.packetsReceived, '| state', after.connectionState);
  assert.equal(after.connectionState, 'connected', 'no reconnect needed');
  assert.ok(after.packetsReceived > before + 100, 'audio kept flowing after the switch');
  assert.match(proc, /noise suppression ON, echo cancel off, auto gain off/);
  assert.equal(await client.evaluate(() => localStorage.getItem('tailmic.ns')), '1', 'choice is remembered');

  // Disconnect cleanly.
  await client.click('#connect');
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
});

await run('a hostile website open on the PC cannot take over the receiver', {
  allowedCidrs: LAB_CIDRS,
  outputDeviceMatch: FAKE_OUTPUT,
}, async ({ receiver, client, srv, cfg }) => {
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
  // A different website (another localhost port = "same-site", the hardest case).
  const evil = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<script>
      window.result = 'pending';
      const es = new EventSource('http://127.0.0.1:${cfg.receiverPort}/api/events');
      es.onopen = () => { window.result = 'opened'; };
      es.onerror = () => { if (window.result === 'pending') window.result = 'blocked'; };
      window.open('http://127.0.0.1:${cfg.receiverPort}/', 'tm');
    </script>`);
  });
  await new Promise((r) => evil.listen(18479, '127.0.0.1', r));
  try {
    const ectx = await receiver.context().browser().newContext({ bypassCSP: true });
    const page = await ectx.newPage();
    await page.goto('http://127.0.0.1:18479/');
    await page.waitForFunction(() => window.result !== 'pending', null, { timeout: 10000 });
    console.log('hostile EventSource:', await page.evaluate(() => window.result));
    await sleep(1000);
    const log = srv.logs.join('');
    assert.match(log, /refused (cross|same)-site request to receiver: GET \/api\/events/);
    assert.equal((log.match(/receiver connected/g) || []).length, 1, 'only the real receiver ever connected');
    // The real receiver still works.
    await waitFor(client, () => !document.getElementById('connect').disabled);
    await client.click('#connect');
    await waitFor(client, () => window.tailmic.stats.connectionState === 'connected');
    await waitFor(receiver, () => (window.tailmic.stats.packetsReceived || 0) > 20);
    await ectx.close();
  } finally { evil.close(); }
});

const connected = (page) => waitFor(page, () => window.tailmic.stats.connectionState === 'connected');
const ready = async ({ receiver, client }) => {
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
  await waitFor(client, () => !document.getElementById('connect').disabled);
};
const offers = (srv) => (srv.logs.join('').match(/offer from/g) || []).length;

await run('bug 1: clicking Disconnect while connecting leaves no mic open and no hidden call', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver, client, srv } = t;
  await ready(t);
  await client.evaluate(() => { window.__gumDelay = 1500; }); // like a slow permission prompt
  await client.click('#connect');
  await sleep(300);
  await client.click('#connect'); // Disconnect
  await sleep(4000);
  const c = await client.evaluate(() => ({ live: window.__liveTracks(), pcs: window.__openPcs(), status: window.tailmic.status }));
  console.log('  after cancel:', JSON.stringify(c), 'offers:', offers(srv));
  assert.equal(c.live, 0, 'mic must be closed');
  assert.equal(c.pcs, 0, 'no connection may exist');
  assert.equal(offers(srv), 0, 'nothing may reach the PC');
  assert.equal(c.status, 'Not connected');
  assert.equal(await receiver.evaluate(() => window.tailmic.status), 'Ready');
});

await run('bugs 1+2: changing settings while connecting gives exactly one call on each side', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver, client, srv } = t;
  await ready(t);
  await client.evaluate(() => { window.__gumDelay = 400; });
  await client.click('#connect');
  for (let i = 0; i < 4; i++) { await sleep(150); await client.click('#ns'); } // rapid toggles mid-connect
  await connected(client);
  await sleep(3000);
  const c = await client.evaluate(() => ({ live: window.__liveTracks(), pcs: window.__openPcs() }));
  const r = await receiver.evaluate(() => ({ pcs: window.__openPcs(), status: window.tailmic.status, pkts: window.tailmic.stats.packetsReceived }));
  console.log('  client', JSON.stringify(c), 'receiver', JSON.stringify(r), 'offers:', offers(srv));
  assert.equal(c.live, 1, 'exactly one mic open');
  assert.equal(c.pcs, 1, 'exactly one connection on the Mac');
  assert.equal(r.pcs, 1, 'exactly one connection on the PC');
  assert.equal(r.status, 'Connected');
  assert.ok(r.pkts > 50, 'audio flows');
});

await run('bug 3: the PC window keeps trying until the server answers', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  await t.receiver.waitForFunction(() => window.tailmic.status === 'Ready', null, { timeout: 20000 });
  console.log('  receiver recovered after failed start-up requests');
}, {
  beforeReceiver: async (rctx) => {
    let fails = 2;
    await rctx.route('**/api/rconfig', (route) => (fails-- > 0 ? route.abort() : route.continue()));
  },
});

await run('bug 4: audio resumes when the Steam device disappears and comes back', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver, client } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  await sleep(1000);
  const gone = async (hide) => receiver.evaluate(async (h) => {
    window.__hideOutputs = h;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await new Promise((r) => setTimeout(r, 800));
    const a = document.getElementById('audio');
    return { paused: a.paused, muted: a.muted, status: window.tailmic.status };
  }, hide);
  const off = await gone(true);
  const on = await gone(false);
  console.log('  device gone:', JSON.stringify(off), ' device back:', JSON.stringify(on));
  assert.equal(off.muted, true, 'muted while the device is missing (never plays to the wrong device)');
  assert.equal(on.paused, false, 'playing again');
  assert.equal(on.status, 'Connected', 'status recovers too');
  assert.equal(on.muted, false);
});

await run('bug 5: unplugging the mic mid-call switches mics without hanging up', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver, client, srv } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  const before = await client.evaluate(() => window.__streams.length);
  await client.evaluate(() => {
    const tr = window.__streams[window.__streams.length - 1].getAudioTracks()[0];
    tr.dispatchEvent(new Event('ended')); // what the browser does when a USB mic is unplugged
  });
  await waitFor(client, (n) => window.__streams.length > n && window.__liveTracks() === 1, before);
  await sleep(1500);
  const p1 = await receiver.evaluate(() => window.tailmic.stats.packetsReceived);
  await sleep(2500); // the PC page counts packets once a second: wait for at least two counts
  const p2 = await receiver.evaluate(() => window.tailmic.stats.packetsReceived);
  const st = await client.evaluate(() => window.tailmic.stats.connectionState);
  console.log('  after unplug: state', st, 'packets', p1, '->', p2, 'offers:', offers(srv));
  assert.equal(st, 'connected');
  assert.equal(offers(srv), 1, 'no reconnect was needed');
  assert.ok(p2 > p1 + 100, 'audio keeps flowing from the new mic');
});

await run('bug 6: no mic is opened while the PC has no Steam device', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: 'No Such Device' }, async (t) => {
  const { receiver, client } = t;
  await waitFor(receiver, () => /not found/i.test(window.tailmic.status));
  await waitFor(client, () => !document.getElementById('connect').disabled);
  await client.click('#connect');
  await sleep(7000); // two retry rounds
  const c = await client.evaluate(() => ({ opened: window.__streams.length, status: window.tailmic.status, msg: document.getElementById('msg').textContent }));
  console.log('  ', JSON.stringify(c));
  assert.equal(c.opened, 0, 'mic never opened');
  assert.equal(c.status, 'Reconnecting...');
  assert.match(c.msg, /Steam Streaming Microphone/);
});

await run('review bug 2: a failed mic switch leaves no extra mic open', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { client } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  await client.evaluate(() => {
    // Make the next track swap fail, like when the call drops in the middle of a switch.
    const orig = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = function () { RTCRtpSender.prototype.replaceTrack = orig; return Promise.reject(new Error('simulated')); };
  });
  const n = await client.evaluate(() => window.__streams.length);
  await client.click('#ns');
  await waitFor(client, (k) => window.__streams.length >= k + 2, n); // the failed switch + the reconnect
  await connected(client);
  await sleep(1500);
  const c = await client.evaluate(() => ({ live: window.__liveTracks(), pcs: window.__openPcs(), state: window.tailmic.stats.connectionState }));
  console.log('  after failed switch:', JSON.stringify(c));
  assert.equal(c.live, 1, 'only the mic of the new call is open');
  assert.equal(c.pcs, 1);
});

await run('review bug 1: closing the Mac tab while the PC answers cancels the call', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver, client, srv } = t;
  await ready(t);
  await receiver.evaluate(() => {
    // Slow PC: hold the answer for 2.5 s.
    const f = window.fetch;
    window.fetch = async (u, o) => { if (String(u).includes('/api/answer')) await new Promise((r) => setTimeout(r, 2500)); return f(u, o); };
  });
  await client.click('#connect');
  for (let i = 0; i < 50 && !/offer from/.test(srv.logs.join('')); i++) await sleep(100);
  await client.close(); // tab closed mid set-up
  await waitFor(receiver, () => window.tailmic.status === 'Ready', null, 6000);
  const log = srv.logs.join('');
  console.log('  server noticed:', /laptop left during set-up/.test(log), '| PC status:', await receiver.evaluate(() => window.tailmic.status));
  assert.match(log, /laptop left during set-up/);
  assert.equal(await receiver.evaluate(() => window.__openPcs()), 0, 'PC dropped the dead call');
});

await run('stop over SSH: the PC window closes itself and the server exits', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver: first, client, srv, cfg, rctx } = t;
  await ready({ receiver: first, client });
  // Like the real app window, the PC window has a one-page history, so it may close itself.
  const opened = rctx.waitForEvent('page');
  await first.evaluate((u) => window.open(u, '_blank'), `http://127.0.0.1:${cfg.receiverPort}/`);
  const receiver = await opened;
  await waitFor(receiver, () => window.tailmic && window.tailmic.status === 'Ready');
  await client.click('#connect');
  await connected(client);
  const base = `http://127.0.0.1:${cfg.receiverPort}`;
  const h = await (await fetch(`${base}/api/health`)).json(); // what status.ps1 reads
  console.log('  health:', JSON.stringify({ window: h.receiverWindow, output: h.outputDevice, call: h.call && h.call.state }));
  assert.equal(h.receiverWindow, true);
  assert.ok(h.outputDevice.includes(FAKE_OUTPUT));
  assert.equal(h.call.user, USER);
  // The page itself may not stop TailMic.
  const fromPage = await receiver.evaluate(async () => (await fetch('/api/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  assert.equal(fromPage, 403);
  const closed = receiver.waitForEvent('close', { timeout: 5000 });
  const q = await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' }); // what stop.ps1 sends
  assert.equal(q.status, 200);
  await closed;
  for (let i = 0; i < 50 && srv.p.exitCode === null; i++) await sleep(100); // the server exits about 1.7 s after it was asked
  console.log('  PC window closed itself; server exit code:', srv.p.exitCode, '| Mac status:', await client.evaluate(() => window.tailmic.status));
  assert.equal(srv.p.exitCode, 0, 'server exited cleanly');
});

await run('two PC windows do not fight over the connection', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async (t) => {
  const { receiver, srv, rctx, cfg } = t;
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
  const second = await rctx.newPage();
  await second.goto(`http://127.0.0.1:${cfg.receiverPort}/`);
  await waitFor(second, () => window.tailmic.status === 'Ready');
  await waitFor(receiver, () => window.tailmic.status === 'Open in another window');
  await sleep(6000);
  const n = (srv.logs.join('').match(/receiver connected/g) || []).length;
  console.log('  receiver connections after 6 s:', n);
  assert.equal(n, 2, 'no ping-pong between windows');
  assert.equal(await second.evaluate(() => window.tailmic.status), 'Ready');
});

// ---------- "Test what the game hears" ----------
// Headless Chromium has no Steam device; with WITH_STEAM_MIC one of its fake microphones stands in for the capture half.
const TEST_CFG = { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT };
const WITH_STEAM_MIC = { steamMic: true };
const testDone = (page, kind) => waitFor(page, (k) => window.tailmic.test && window.tailmic.test.kind === k, kind, 30000);
const pcListening = (receiver) => receiver.evaluate(() => ({ live: window.__liveTracks(), row: document.getElementById('test').textContent }));
const health = async (cfg) => (await fetch(`http://127.0.0.1:${cfg.receiverPort}/api/health`)).json();

await run('test what the game hears: record and play back; the PC listens only during the test', TEST_CFG, async (t) => {
  const { receiver, client, cfg, srv } = t;
  await ready(t);
  assert.equal(await client.isDisabled('#testRec'), true, 'no test without a call');
  await client.click('#connect');
  await connected(client);
  await waitFor(client, () => !document.getElementById('testRec').disabled);
  assert.deepEqual(await pcListening(receiver), { live: 0, row: 'off' }, 'the PC does not listen during a normal call');
  const sentBefore = await receiver.evaluate(async () => {
    let n = 0;
    (await window.__pcs[window.__pcs.length - 1].getStats()).forEach((s) => { if (s.type === 'outbound-rtp') n += s.packetsSent || 0; });
    return n;
  });
  assert.equal(sentBefore, 0, 'nothing is sent back to the laptop outside a test');

  await client.click('#testRec');
  await waitFor(receiver, () => window.__liveTracks() === 1);
  const during = await pcListening(receiver);
  assert.equal(during.row, 'ON - sending "Microphone (Steam Streaming Microphone)" back to the laptop', 'the PC window shows that it is listening, and to what');
  assert.equal((await health(cfg)).test, true, 'status shows it too');
  await testDone(client, 'rec');
  const rec = await client.evaluate(() => window.tailmic.test);
  await waitFor(client, () => /That is what the game hears/.test(document.getElementById('testMsg').textContent), null, 15000);
  console.log('  recording:', JSON.stringify(rec), '| PC during:', JSON.stringify(during));
  assert.ok(rec.seconds > 4 && rec.seconds < 6.5, `about 5 s recorded, got ${rec.seconds}`);
  assert.ok(rec.peak > 0.002, 'the audio that came back is not silent');
  await waitFor(receiver, () => window.__liveTracks() === 0);
  assert.deepEqual(await pcListening(receiver), { live: 0, row: 'off' }, 'the PC stopped listening when the test ended');
  await waitFor(client, () => !document.getElementById('testRec').disabled);
  assert.equal((await health(cfg)).test, false);
  assert.equal(await client.evaluate(() => window.tailmic.stats.connectionState), 'connected', 'the call stayed up');
  assert.match(srv.logs.join(''), /test: test@example\.com listens to what the game hears/, 'the test is logged');
}, WITH_STEAM_MIC);

await run('test what the game hears: the tone check tells right from wrong device formats', TEST_CFG, async (t) => {
  const { receiver, client } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  await waitFor(client, () => !document.getElementById('testTone').disabled);
  const check = async (speed) => {
    await receiver.evaluate((x) => { window.__loop = x; }, speed);
    await client.click('#testTone');
    await testDone(client, 'tone');
    const res = await client.evaluate(() => ({ ...window.tailmic.test, msg: document.getElementById('testMsg').textContent, cls: document.getElementById('testMsg').className }));
    await waitFor(client, () => !document.getElementById('testTone').disabled);
    await waitFor(receiver, () => window.__liveTracks() === 0);
    console.log(`  device speed ${speed}:`, res.verdict, `${res.hz} Hz`);
    return res;
  };
  const ok = await check(1);
  assert.equal(ok.verdict, 'ok');
  assert.ok(Math.abs(ok.hz - 1000) < 15, `1000 Hz comes back as 1000 Hz, got ${ok.hz}`);
  assert.match(ok.msg, /Tone check passed/);
  assert.match(ok.cls, /good/);

  const half = await check(0.5);
  assert.equal(half.verdict, 'half', 'stereo read as mono');
  assert.ok(Math.abs(half.hz - 500) < 10, `got ${half.hz}`);
  assert.match(half.msg, /HALF speed/);
  assert.match(half.msg, /Recording tab .* "Microphone \(Steam Streaming Microphone\)"/, 'says which half to change');
  assert.match(half.msg, /channels, bits and Hz must all match/);
  assert.match(half.cls, /err/);

  const rate = await check(44100 / 48000);
  assert.equal(rate.verdict, 'rate_low', '48000 Hz read as 44100 Hz');
  assert.ok(Math.abs(rate.hz - 919) < 10, `got ${rate.hz}`);
  assert.match(rate.msg, /different sample rates/);

  const silent = await check(0);
  assert.equal(silent.verdict, 'silent');
  assert.match(silent.msg, /Nothing came back/);

  // Afterwards the microphone is back, and the call never dropped.
  const after = await client.evaluate(() => {
    const pc = window.__pcs[window.__pcs.length - 1];
    return { track: pc.getSenders()[0].track.label, state: pc.connectionState, pcs: window.__openPcs(), micDisabled: document.getElementById('mic').disabled };
  });
  console.log('  after the tone checks:', JSON.stringify(after));
  assert.match(after.track, /Fake/, 'the microphone is sent again, not the tone');
  assert.equal(after.state, 'connected');
  assert.equal(after.pcs, 1, 'no reconnect was needed');
  assert.equal(after.micDisabled, false);
  const p1 = await receiver.evaluate(() => window.tailmic.stats.packetsReceived);
  await sleep(2500); // the PC page counts packets once a second: wait for at least two counts
  assert.ok(await receiver.evaluate(() => window.tailmic.stats.packetsReceived) > p1 + 100, 'microphone audio flows again');
}, WITH_STEAM_MIC);

await run('test what the game hears: listening live stops on "Stop listening" and when the call ends', TEST_CFG, async (t) => {
  const { receiver, client } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  await waitFor(client, () => !document.getElementById('testLive').disabled);
  await client.click('#testLive');
  await waitFor(receiver, () => window.__liveTracks() === 1);
  await waitFor(client, () => { const m = document.getElementById('monitor'); return !m.muted && !m.paused && m.srcObject; });
  const ui = await client.evaluate(() => ({ live: document.getElementById('testLive').textContent, rec: document.getElementById('testRec').disabled }));
  assert.deepEqual(ui, { live: 'Stop listening', rec: true });
  await client.click('#testLive');
  await waitFor(receiver, () => window.__liveTracks() === 0);
  assert.equal(await client.evaluate(() => document.getElementById('monitor').srcObject), null, 'nothing is played any more');
  // Start again, then hang up in the middle.
  await waitFor(client, () => !document.getElementById('testLive').disabled);
  await client.click('#testLive');
  await waitFor(receiver, () => window.__liveTracks() === 1);
  await client.click('#connect'); // Disconnect
  await waitFor(receiver, () => window.__liveTracks() === 0 && window.tailmic.status === 'Ready');
  const end = await client.evaluate(() => ({ live: document.getElementById('testLive').textContent, off: document.getElementById('testLive').disabled, paused: document.getElementById('monitor').paused }));
  console.log('  after hanging up mid-test:', JSON.stringify(end), '| PC:', JSON.stringify(await pcListening(receiver)));
  assert.deepEqual(end, { live: 'Listen live', off: true, paused: true });
}, WITH_STEAM_MIC);

// This PC has microphones, but not Steam's. The old "captureDeviceMatch" setting is given on
// purpose: it must make no difference any more.
await run('test what the game hears: the PC refuses to listen to any other microphone, whatever the settings say', { ...TEST_CFG, captureDeviceMatch: 'Fake Audio Input' }, async (t) => {
  const { receiver, client } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  await waitFor(client, () => !document.getElementById('testRec').disabled);
  const opened = await receiver.evaluate(() => window.__streams.length);
  await client.click('#testRec');
  await waitFor(client, () => /cannot find "Microphone \(Steam Streaming Microphone\)"/.test(document.getElementById('testMsg').textContent));
  await sleep(500);
  const r = await receiver.evaluate(() => ({ opened: window.__streams.length, live: window.__liveTracks(), row: document.getElementById('test').textContent }));
  console.log('  PC without the Steam microphone:', JSON.stringify(r), '|', await client.textContent('#testMsg'));
  assert.equal(r.opened, opened, 'no microphone was opened at all');
  assert.deepEqual({ live: r.live, row: r.row }, { live: 0, row: 'off' });
  assert.equal(await client.evaluate(() => window.tailmic.stats.connectionState), 'connected');
});

await run('test what the game hears: the PC stops listening at once if its confirmation is refused', TEST_CFG, async (t) => {
  const { receiver, client } = t;
  await ready(t);
  await client.click('#connect');
  await connected(client);
  await waitFor(client, () => !document.getElementById('testRec').disabled);
  const opened = await receiver.evaluate(() => window.__streams.length);
  await client.click('#testRec');
  await waitFor(receiver, (n) => window.__streams.length > n, opened); // the PC opened the microphone...
  await waitFor(receiver, () => window.__liveTracks() === 0, null, 3000); // ...and closed it again, long before the 30-second limit
  assert.deepEqual(await pcListening(receiver), { live: 0, row: 'off' });
  await waitFor(client, () => /did not start the test in time/.test(document.getElementById('testMsg').textContent), null, 12000);
  console.log('  laptop was told:', await client.textContent('#testMsg'));
  assert.equal(await client.evaluate(() => window.tailmic.stats.connectionState), 'connected');
}, {
  // As if the laptop had given up, or stopped the test, while the PC was still opening the microphone.
  steamMic: true,
  beforeReceiver: (rctx) => rctx.route('**/api/testack', (route) => route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"no_such_test"}' })),
});

// ---------- the PC window's own browser profile ----------
await run('PC profile: TailMic\'s own page gets audio devices without a prompt and without opening any microphone; other sites get nothing',
  TEST_CFG, async (t) => {
    const { receiver, client, cfg, rctx } = t;
    await ready(t);
    const start = await receiver.evaluate(async () => ({
      permission: (await navigator.permissions.query({ name: 'microphone' })).state,
      opened: window.__streams.length,
      device: document.getElementById('device').textContent,
    }));
    console.log('  PC window at start:', JSON.stringify(start));
    assert.equal(start.permission, 'granted');
    assert.equal(start.opened, 0, 'no microphone was opened to find the device');
    assert.match(start.device, /Fake Audio Output/);
    // A complete call, and a tone check, under the page's real security policy.
    const violations = [];
    receiver.on('console', (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
    await client.click('#connect');
    await connected(client);
    await waitFor(receiver, () => (window.tailmic.stats.packetsReceived || 0) > 50);
    assert.equal(await receiver.evaluate(() => window.__streams.length), 0, 'still no microphone opened during a normal call');
    await receiver.evaluate(() => { window.__loop = 1; });
    await waitFor(client, () => !document.getElementById('testTone').disabled);
    await client.click('#testTone');
    await testDone(client, 'tone');
    assert.equal(await client.evaluate(() => window.tailmic.test.verdict), 'ok');
    assert.deepEqual(violations, [], 'the page broke none of its own security rules');
    // Any other site opened in the same profile has no permission at all.
    const other = await rctx.newPage();
    await other.goto(`http://localhost:${cfg.receiverPort}/icon.svg`); // to a browser, "localhost" is a different site than "127.0.0.1"
    const elsewhere = await other.evaluate(async () => ({
      site: location.origin,
      permission: (await navigator.permissions.query({ name: 'microphone' })).state,
      names: (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.label).length,
    }));
    console.log('  another site in the same profile:', JSON.stringify(elsewhere));
    assert.equal(elsewhere.site, `http://localhost:${cfg.receiverPort}`);
    assert.equal(elsewhere.permission, 'prompt', 'not allowed in advance');
    assert.equal(elsewhere.names, 0, 'cannot even see device names');
  }, { realProfile: (cfg) => `http://127.0.0.1:${cfg.receiverPort}`, steamMic: true });

await run('PC profile: without the permission the window says so, status reports it, and nothing is opened',
  { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async ({ receiver, cfg }) => {
    await waitFor(receiver, () => window.tailmic.status === 'Needs permission');
    let h;
    for (let i = 0; i < 20; i++) { h = await health(cfg); if (h.needsPermission) break; await sleep(200); }
    console.log('  health:', JSON.stringify({ window: h.receiverWindow, needsPermission: h.needsPermission, output: h.outputDevice }));
    assert.equal(h.receiverWindow, true, 'the window is connected, so status can explain what it waits for');
    assert.equal(h.needsPermission, true);
    assert.equal(h.outputDevice, null);
    assert.equal(await receiver.evaluate(() => window.__liveTracks()), 0);
  }, { realProfile: () => 'http://127.0.0.1:9' }); // prepared for some other site: as good as not prepared

await run('Tailscale-only policy refuses a non-Tailscale network (this container has no 100.x address)', {
  outputDeviceMatch: FAKE_OUTPUT,
}, async ({ receiver, client, srv }) => {
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
  await waitFor(client, () => !document.getElementById('connect').disabled);
  await client.click('#connect');
  await waitFor(client, () => /no Tailscale address/i.test(document.getElementById('msg').textContent));
  const msg = await client.textContent('#msg');
  console.log('client message:', msg);
  assert.ok(!srv.logs.join('').includes('offer from'), 'no offer may reach the PC');
});

await run('wrong Tailscale user is refused', { allowedUsers: ['someone-else@example.com'] }, async ({ client, cfg }) => {
  const res = await client.goto(`http://127.0.0.1:${cfg.clientPort}/`);
  assert.equal(res.status(), 403);
  const text = await client.textContent('body');
  console.log('page says:', text.trim());
  assert.match(text, /is not allowed on this PC/);
  const api = await client.context().request.get(`http://127.0.0.1:${cfg.clientPort}/api/config`);
  assert.equal(api.status(), 403);
  const noHeader = await fetch(`http://127.0.0.1:${cfg.clientPort}/api/config`);
  assert.equal(noHeader.status, 403);
});

// UI screenshots for a human look.
await run('screenshots', { allowedCidrs: LAB_CIDRS, outputDeviceMatch: FAKE_OUTPUT }, async ({ receiver, client }) => {
  await waitFor(receiver, () => window.tailmic.status === 'Ready');
  await waitFor(client, () => !document.getElementById('connect').disabled);
  await client.click('#connect');
  await waitFor(client, () => window.tailmic.stats.connectionState === 'connected');
  await sleep(2500);
  const out = process.env.SHOTS || '/tmp';
  await client.setViewportSize({ width: 480, height: 760 });
  await receiver.setViewportSize({ width: 480, height: 640 });
  await client.screenshot({ path: path.join(out, 'client.png') });
  await receiver.screenshot({ path: path.join(out, 'receiver.png') });
});
