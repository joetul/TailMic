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
    md.getUserMedia = async (c) => {
      if (window.__gumDelay) await new Promise((r) => setTimeout(r, window.__gumDelay));
      const st = await gum(c);
      window.__streams.push(st);
      return st;
    };
    const enumerate = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => (await enumerate()).filter((d) => !(window.__hideOutputs && d.kind === 'audiooutput'));
  }
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Orig { constructor(...a) { super(...a); window.__pcs.push(this); } };
  window.__liveTracks = () => window.__streams.flatMap((x) => x.getTracks()).filter((t) => t.readyState === 'live').length;
  window.__openPcs = () => window.__pcs.filter((x) => x.connectionState !== 'closed' && x.signalingState !== 'closed').length;
};

async function run(name, cfgOverrides, body, { beforeReceiver } = {}) {
  const cfg = { clientPort: 18470, receiverPort: 18471, allowedUsers: [USER], ...cfgOverrides };
  const srv = startServer(cfg);
  await sleep(500);
  const browser = await chromium.launch({
    channel: 'chromium', // full Chromium in new headless mode
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const rctx = await browser.newContext({ bypassCSP: true }); // lets the test runner evaluate its probes
    await rctx.grantPermissions(['microphone']);
    await rctx.addInitScript(PROBES);
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
  const a = await client.evaluate(() => ({ ...window.tailmic.stats }));
  await sleep(3000);
  const b = await client.evaluate(() => ({ ...window.tailmic.stats }));
  const avgPps = ((b.packetsSent - a.packetsSent) * 1000) / (b.t - a.t);
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
  await sleep(1500);
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
  await sleep(1500);
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
