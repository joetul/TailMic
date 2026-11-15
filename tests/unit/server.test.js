import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start, loadConfig } from '../../app/server.js';

const USER = 'me@example.com';
const OFFER_SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 192.168.1.2\r\n'
  + 'a=candidate:1 1 udp 1 192.168.1.2 5000 typ host\r\na=candidate:2 1 udp 1 100.100.1.1 5001 typ host\r\na=rtpmap:111 opus/48000/2\r\n';

function req(port, path, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (host) h.Host = host;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* html */ } resolve({ status: res.statusCode, json: j, text: t, headers: res.headers }); });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

function openSse(port, onEvent) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block); const d = /^data: (.*)$/m.exec(block);
          if (ev && d) onEvent(ev[1], JSON.parse(d[1]));
        }
      });
      resolve(r);
    });
  });
}

async function boot(extra = {}, hooks = {}) {
  const cfg = loadConfig();
  cfg.clientPort = 0; cfg.receiverPort = 0; cfg.allowedUsers = [USER];
  Object.assign(cfg, extra);
  const s = await start(cfg, hooks);
  cfg.receiverPort = s.receiverPort; // Host checks use the real ports
  cfg.clientPort = s.clientPort;
  const c = (path, opts = {}) => req(s.clientPort, path, { ...opts, headers: { 'Tailscale-User-Login': USER, ...(opts.headers || {}) } });
  const r = (path, opts = {}) => req(s.receiverPort, path, { host: `127.0.0.1:${s.receiverPort}`, ...opts });
  const close = () => { s.clientServer.closeAllConnections?.(); s.receiverServer.closeAllConnections?.(); s.clientServer.close(); s.receiverServer.close(); };
  return { s, cfg, c, r, close };
}

test('client side: identity header is required and must match', async () => {
  const { s, c, close } = await boot();
  try {
    assert.equal((await req(s.clientPort, '/api/config')).status, 403);
    assert.equal((await req(s.clientPort, '/')).status, 403);
    assert.equal((await c('/api/config', { headers: { 'Tailscale-User-Login': 'evil@example.com' } })).status, 403);
    const ok = await c('/api/config', { headers: { 'Tailscale-User-Login': 'ME@Example.com' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user, USER);
    assert.equal(ok.json.receiverOnline, false);
    const page = await c('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  } finally { close(); }
});

test('client side: cross-site POSTs, non-JSON and huge bodies are refused', async () => {
  const { c, close } = await boot();
  try {
    assert.equal((await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await c('/api/offer', { method: 'POST', body: 'sdp=x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await c('/api/offer', { method: 'POST', body: { sdp: 'v=0' + 'x'.repeat(70000) } })).status, 413);
  } finally { close(); }
});

test('offer returns 503 when the PC receiver is offline', async () => {
  const { c, close } = await boot();
  try {
    const res = await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'receiver_offline');
  } finally { close(); }
});

test('receiver side: wrong Host header (DNS rebinding) is refused', async () => {
  const { s, r, close } = await boot();
  try {
    assert.equal((await req(s.receiverPort, '/api/rconfig', { host: 'evil.example:80' })).status, 403);
    assert.equal((await r('/api/rconfig')).status, 200);
  } finally { close(); }
});

test('receiver side: other websites cannot open the page, the event stream or POST', async () => {
  const { s, r, close } = await boot();
  let sse;
  try {
    for (const site of ['cross-site', 'same-site']) {
      const h = { 'Sec-Fetch-Site': site };
      assert.equal((await r('/api/events', { headers: h })).status, 403, `events ${site}`);
      assert.equal((await r('/', { headers: h })).status, 403, `page ${site}`);
      assert.equal((await r('/api/rconfig', { headers: h })).status, 403, `rconfig ${site}`);
      assert.equal((await r('/api/rstatus', { method: 'POST', body: { deviceFound: true }, headers: h })).status, 403, `rstatus ${site}`);
    }
    assert.equal((await r('/api/rstatus', { method: 'POST', body: { deviceFound: true }, headers: { 'Sec-Fetch-Site': 'none' } })).status, 403);
    // The real receiver window: direct open ('none') and its own requests ('same-origin').
    assert.equal((await r('/', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
    assert.equal((await r('/api/rconfig', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    // A refused event-stream attempt must not replace the connected receiver.
    sse = await openSse(s.receiverPort, () => {});
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(s.state.receiver, 'receiver connected');
    const before = s.state.receiver;
    assert.equal((await r('/api/events', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(s.state.receiver, before, 'receiver was not replaced');
  } finally { sse?.destroy(); close(); }
});

test('full signaling round trip filters candidates on both sides', async () => {
  const { s, c, r, close } = await boot();
  let sse;
  try {
    const offers = [];
    sse = await openSse(s.receiverPort, async (ev, d) => {
      if (ev !== 'offer') return;
      offers.push(d);
      const answer = d.sdp.replace('100.100.1.1 5001', '100.100.9.9 6001').replace('192.168.1.2 5000', '10.1.1.1 6000');
      await r('/api/answer', { method: 'POST', body: { id: d.id, sdp: answer } });
    });
    await new Promise((res) => setTimeout(res, 100));
    // Receiver reports no device yet -> client gets a clear error
    let res = await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'no_output_device');

    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true, deviceLabel: 'Speakers (Steam Streaming Microphone)', state: 'idle' } });
    // No Tailscale candidate in the offer -> refused before reaching the PC
    res = await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP.replace('100.100.1.1', '192.168.1.3') } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'no_tailscale_candidates');

    res = await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(offers.length, 1);
    assert.equal(offers[0].user, USER);
    assert.ok(!offers[0].sdp.includes('192.168.1.2'), 'LAN candidate must not reach the PC');
    assert.ok(res.json.sdp.includes('100.100.9.9'));
    assert.ok(!res.json.sdp.includes('10.1.1.1'), 'LAN candidate must not reach the laptop');
    const cfg = await c('/api/config');
    assert.equal(cfg.json.receiverOnline, true);
    assert.equal(cfg.json.activeSession, res.json.id);
    assert.equal((await c('/api/hangup', { method: 'POST', body: { id: res.json.id } })).status, 200);
  } finally { sse?.destroy(); close(); }
});

test('loadConfig tolerates a UTF-8 BOM and a single allowedUsers string', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 'config.json');
  fs.writeFileSync(f, '﻿{"allowedUsers":"Me@Example.com","httpsPort":8444}');
  const cfg = loadConfig(f);
  assert.deepEqual(cfg.allowedUsers, ['me@example.com']);
  assert.equal(cfg.httpsPort, 8444);
  assert.deepEqual(cfg.allowedCidrs, ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']);
});

test('repeated log lines are limited per key, with a summary', async () => {
  const { makeLimitedLog } = await import('../../app/server.js');
  const lines = [];
  let t = 0;
  const L = makeLimitedLog((...a) => lines.push(a.join(' ')), 3, 1000, () => t);
  for (let i = 0; i < 10; i++) L('refused:cross-site', 'refused', i);
  L('denied:x', 'denied x');
  assert.deepEqual(lines, ['refused 0', 'refused 1', 'refused 2', 'denied x']);
  t = 1500;
  L('refused:cross-site', 'refused again');
  assert.deepEqual(lines.slice(4), ['(7 more "refused:cross-site" messages suppressed)', 'refused again']);
});

test('a second receiver window replaces the first, which is told so', async () => {
  const { s, close } = await boot();
  const got = [];
  let a, b;
  try {
    a = await openSse(s.receiverPort, (ev) => got.push(`a:${ev}`));
    await new Promise((r) => setTimeout(r, 100));
    b = await openSse(s.receiverPort, (ev) => got.push(`b:${ev}`));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(got.includes('a:replaced'), JSON.stringify(got));
    assert.ok(!got.includes('b:replaced'));
  } finally { a?.destroy(); b?.destroy(); close(); }
});

// ---------- fixes from the Grok review ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSWER = (ip) => OFFER_SDP.replace('100.100.1.1 5001', `${ip} 6001`);

test('client port only answers for the PC name or loopback (DNS rebinding)', async () => {
  let b = await boot();
  try {
    assert.equal((await b.c('/api/config', { host: 'evil.example:8470' })).status, 403);
    assert.equal((await b.c('/', { host: 'evil.example' })).status, 403);
    assert.equal((await b.c('/api/config', { host: 'anything.tail1.ts.net:8443' })).status, 200, 'no saved name: any *.ts.net');
  } finally { b.close(); }
  b = await boot({ serveHost: 'pc.tail1.ts.net' });
  try {
    assert.equal((await b.c('/api/config', { host: 'pc.tail1.ts.net:8443' })).status, 200);
    assert.equal((await b.c('/api/config', { host: 'PC.tail1.ts.net' })).status, 200);
    assert.equal((await b.c('/api/config', { host: 'other.tail1.ts.net:8443' })).status, 403);
    assert.equal((await b.c('/api/config')).status, 200, 'loopback (what Serve may forward) still works');
  } finally { b.close(); }
});

test('laptop leaving while the PC answers cancels the call', async () => {
  const { s, c, r, close } = await boot();
  const events = [];
  let sse;
  try {
    sse = await openSse(s.receiverPort, (ev, d) => events.push([ev, d]));
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
    const data = JSON.stringify({ sdp: OFFER_SDP });
    const creq = http.request({ host: '127.0.0.1', port: s.clientPort, path: '/api/offer', method: 'POST',
      headers: { 'Tailscale-User-Login': USER, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } });
    creq.on('error', () => {});
    creq.end(data);
    for (let i = 0; i < 50 && !events.some(([e]) => e === 'offer'); i++) await wait(20);
    const offer = events.find(([e]) => e === 'offer')[1];
    creq.destroy(); // tab closed
    for (let i = 0; i < 50 && !events.some(([e, d]) => e === 'hangup' && d.id === offer.id); i++) await wait(20);
    assert.ok(events.some(([e, d]) => e === 'hangup' && d.id === offer.id), 'PC told to hang up');
    assert.equal(s.state.session, null, 'no session left behind');
    // A late answer from the PC is refused.
    assert.equal((await r('/api/answer', { method: 'POST', body: { id: offer.id, sdp: ANSWER('100.100.9.9') } })).status, 410);
    assert.equal((await c('/api/config')).json.activeSession, null);
  } finally { sse?.destroy(); close(); }
});

test('hangup while the PC is answering ends the waiting request at once', async () => {
  const { s, c, r, close } = await boot();
  let sse;
  try {
    let offer;
    sse = await openSse(s.receiverPort, (ev, d) => { if (ev === 'offer') offer = d; });
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
    const t0 = Date.now();
    const pending = c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    for (let i = 0; i < 50 && !offer; i++) await wait(20);
    await c('/api/hangup', { method: 'POST', body: { id: offer.id } });
    const res = await pending;
    assert.equal(res.status, 409);
    assert.ok(Date.now() - t0 < 2000, 'not stuck until the 15 s timeout');
  } finally { sse?.destroy(); close(); }
});

test('the PC window reporting a dropped call clears the active session', async () => {
  const { s, c, r, close } = await boot();
  let sse;
  try {
    sse = await openSse(s.receiverPort, async (ev, d) => {
      if (ev === 'offer') await r('/api/answer', { method: 'POST', body: { id: d.id, sdp: ANSWER('100.100.9.9') } });
    });
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
    const res = await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    assert.equal(res.status, 200);
    assert.equal((await c('/api/config')).json.activeSession, res.json.id);
    await r('/api/ended', { method: 'POST', body: { id: res.json.id } });
    assert.equal((await c('/api/config')).json.activeSession, null);
  } finally { sse?.destroy(); close(); }
});

test("the PC's side is pinned to the PC's exact Tailscale IPs", async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ts-'));
  const fake = path.join(dir, 'tailscale');
  fs.writeFileSync(fake, '#!/bin/sh\necho 100.100.9.9\necho fd7a:115c:a1e0::9\n');
  fs.chmodSync(fake, 0o755);
  const { s, c, r, close } = await boot({ tailscaleExe: fake });
  let sse;
  try {
    sse = await openSse(s.receiverPort, async (ev, d) => {
      if (ev !== 'offer') return;
      // The PC browser offers its real Tailscale IP AND another 100.x address (e.g. a CGNAT LAN).
      const sdp = ANSWER('100.100.9.9') + 'a=candidate:9 1 udp 1 100.70.0.5 7000 typ host\r\n';
      await r('/api/answer', { method: 'POST', body: { id: d.id, sdp } });
    });
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
    const cfg = await c('/api/config');
    assert.deepEqual(cfg.json.pcIps, ['100.100.9.9', 'fd7a:115c:a1e0::9']);
    const res = await c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    assert.equal(res.status, 200);
    assert.ok(res.json.sdp.includes('100.100.9.9'));
    assert.ok(!res.json.sdp.includes('100.70.0.5'), 'other 100.x address removed');
  } finally { sse?.destroy(); close(); }
});

test('a huge streamed body is refused and cut off; the server keeps working', async () => {
  const { s, c, close } = await boot();
  try {
    const outcome = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port: s.clientPort, path: '/api/offer', method: 'POST',
        headers: { 'Tailscale-User-Login': USER, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      q.on('error', (e) => resolve(e.code));
      const chunk = Buffer.alloc(256 * 1024, 120);
      let sent = 0;
      const pump = () => {
        while (sent < 8 * 1024 * 1024) { sent += chunk.length; if (!q.write(chunk)) return q.once('drain', pump); }
        q.end();
      };
      pump();
      setTimeout(() => resolve('timeout'), 8000);
    });
    assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(outcome), `got ${outcome}`);
    assert.equal((await c('/api/config')).status, 200);
  } finally { close(); }
});

// ---------- start/stop/status over SSH ----------
test('health is readable by local tools; quit only by local tools, never by a web page', async () => {
  let quits = 0;
  const { s, r, close } = await boot({}, { onQuit: () => quits++ });
  const events = [];
  let sse;
  try {
    let h = await r('/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.server, true);
    assert.equal(h.json.receiverWindow, false);
    sse = await openSse(s.receiverPort, (ev) => events.push(ev));
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true, deviceLabel: 'Speakers (Steam Streaming Microphone)' } });
    h = await r('/api/health');
    assert.equal(h.json.receiverWindow, true);
    assert.equal(h.json.outputDevice, 'Speakers (Steam Streaming Microphone)');
    assert.equal(h.json.call, null);
    // A web page (even TailMic's own) always sends Sec-Fetch-Site: refused.
    for (const site of ['same-origin', 'cross-site', 'none']) {
      assert.equal((await r('/api/quit', { method: 'POST', body: {}, headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
    }
    assert.equal((await r('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(quits, 0);
    const q = await r('/api/quit', { method: 'POST', body: { confirm: true } });
    assert.equal(q.status, 200);
    assert.equal(q.json.receiverWindow, true);
    await wait(1700);
    assert.ok(events.includes('quit'), 'window told to close');
    assert.equal(quits, 1, 'server shuts down');
  } finally { sse?.destroy(); close(); }
});

// ---------- "Test what the game hears" ----------
// A connected call: the fake PC window answers offers and records test requests.
async function bootWithCall(onTest) {
  const b = await boot();
  const tests = [];
  b.sse = await openSse(b.s.receiverPort, async (ev, d) => {
    if (ev === 'offer') await b.r('/api/answer', { method: 'POST', body: { id: d.id, sdp: ANSWER('100.100.9.9') } });
    if (ev === 'test') { tests.push(d); await onTest?.(d); }
  });
  await b.r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
  const res = await b.c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
  assert.equal(res.status, 200);
  return { ...b, id: res.json.id, tests, close: () => { b.sse.destroy(); b.close(); } };
}

test('test: only the allowed user, and only for their own connected call', async () => {
  const b = await bootWithCall();
  try {
    const start = { id: b.id, action: 'start' };
    assert.equal((await req(b.s.clientPort, '/api/test', { method: 'POST', body: start })).status, 403, 'no Tailscale identity');
    assert.equal((await b.c('/api/test', { method: 'POST', body: start, headers: { 'Tailscale-User-Login': 'evil@example.com' } })).status, 403);
    assert.equal((await b.c('/api/test', { method: 'POST', body: start, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await b.c('/api/test', { method: 'POST', body: { id: 'not-my-call', action: 'start' } })).status, 409);
    assert.equal((await b.c('/api/test', { method: 'POST', body: { id: b.id, action: 'record-forever' } })).status, 400);
    assert.equal(b.tests.length, 0, 'none of these reached the PC window');
    // A web page on the PC cannot fake the PC window's confirmation either.
    assert.equal((await b.r('/api/testack', { method: 'POST', body: { id: b.id, ok: true }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await b.r('/api/testack', { method: 'POST', body: { id: b.id, ok: true } })).status, 410, 'no test was asked for');
  } finally { b.close(); }
});

test('test: no call, no test', async () => {
  const { c, close } = await boot();
  try {
    const res = await c('/api/test', { method: 'POST', body: { id: 'x', action: 'start' } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'no_call');
  } finally { close(); }
});

test('test: start waits for the PC window, stop is passed on, and health shows it', async () => {
  let b;
  b = await bootWithCall(async (d) => {
    if (d.action !== 'start') return;
    await b.r('/api/rstatus', { method: 'POST', body: { deviceFound: true, testing: true } });
    await b.r('/api/testack', { method: 'POST', body: { id: d.id, ok: true, device: 'Microphone (Steam Streaming Microphone)' } });
  });
  try {
    const res = await b.c('/api/test', { method: 'POST', body: { id: b.id, action: 'start' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.device, 'Microphone (Steam Streaming Microphone)');
    assert.deepEqual(b.tests, [{ id: b.id, action: 'start' }]);
    assert.equal((await b.r('/api/health')).json.test, true, 'status shows that the laptop is listening');
    assert.equal((await b.c('/api/test', { method: 'POST', body: { id: b.id, action: 'stop' } })).status, 200);
    await wait(50);
    assert.deepEqual(b.tests[1], { id: b.id, action: 'stop' });
  } finally { b.close(); }
});

test('test: a PC that cannot open the Steam microphone gives a clear error and is told to stop', async () => {
  let b;
  b = await bootWithCall(async (d) => {
    if (d.action === 'start') await b.r('/api/testack', { method: 'POST', body: { id: d.id, ok: false, error: 'no_capture_device', message: 'The PC cannot find it.' } });
  });
  try {
    const res = await b.c('/api/test', { method: 'POST', body: { id: b.id, action: 'start' } });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'no_capture_device');
    assert.equal(res.json.message, 'The PC cannot find it.');
    await wait(50);
    assert.deepEqual(b.tests.map((t) => t.action), ['start', 'stop'], 'never left listening after a failed start');
  } finally { b.close(); }
});

// ---------- audit fixes ----------
test('with two allowed users, one cannot hang up or test the other\'s call', async () => {
  const OTHER = 'other@example.com';
  const b = await boot({ allowedUsers: [USER, OTHER] });
  const events = [];
  let sse;
  try {
    sse = await openSse(b.s.receiverPort, async (ev, d) => {
      events.push(ev);
      if (ev === 'offer') await b.r('/api/answer', { method: 'POST', body: { id: d.id, sdp: ANSWER('100.100.9.9') } });
    });
    await b.r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
    const call = await b.c('/api/offer', { method: 'POST', body: { sdp: OFFER_SDP } });
    assert.equal(call.status, 200);
    const asOther = { 'Tailscale-User-Login': OTHER };
    assert.equal((await b.c('/api/config', { headers: asOther })).json.activeSession, call.json.id, 'the other user can see that a call is up');
    await b.c('/api/hangup', { method: 'POST', body: { id: call.json.id }, headers: asOther });
    assert.equal((await b.c('/api/config')).json.activeSession, call.json.id, 'the call is still up');
    assert.equal((await b.c('/api/test', { method: 'POST', body: { id: call.json.id, action: 'start' }, headers: asOther })).status, 409);
    await wait(50);
    assert.ok(!events.includes('hangup') && !events.includes('test'), 'the PC window was told nothing');
    assert.equal((await b.c('/api/hangup', { method: 'POST', body: { id: call.json.id } })).status, 200);
    assert.equal((await b.c('/api/config')).json.activeSession, null, 'the owner can hang up');
  } finally { sse?.destroy(); b.close(); }
});

test('version and fingerprint: the running server and `server.js --build` agree', async () => {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { buildInfo } = await import('../../app/server.js');
  const info = buildInfo();
  assert.equal(info.version, JSON.parse(fs.readFileSync(new URL('../../app/package.json', import.meta.url), 'utf8')).version);
  assert.match(info.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(buildInfo(), info, 'the same files give the same fingerprint');
  const { r, close } = await boot();
  try {
    const h = (await r('/api/health')).json;
    assert.equal(h.version, info.version);
    assert.equal(h.build, info.id);
    assert.ok(h.appDir.endsWith('app'), h.appDir);
  } finally { close(); }
  // What `TailMic.cmd status` runs to learn which version the files on disk are.
  const out = execFileSync(process.execPath, [new URL('../../app/server.js', import.meta.url).pathname, '--build'], { encoding: 'utf8' });
  assert.equal(out, `${info.version} ${info.id}\n`);
});

test('receiver side: a request that names another site as its origin is refused, even without Sec-Fetch-Site', async () => {
  const { s, r, close } = await boot();
  try {
    const own = `http://127.0.0.1:${s.receiverPort}`;
    assert.equal((await r('/api/rstatus', { method: 'POST', body: { deviceFound: true }, headers: { Origin: own } })).status, 200, 'the page itself');
    assert.equal((await r('/api/rconfig')).status, 200, 'local tools send no Origin');
    for (const origin of ['https://evil.example', `http://127.0.0.1:${s.receiverPort + 1}`, `http://localhost:${s.receiverPort}`, 'null']) {
      assert.equal((await r('/api/events', { headers: { Origin: origin } })).status, 403, `events from ${origin}`);
      assert.equal((await r('/api/quit', { method: 'POST', body: {}, headers: { Origin: origin } })).status, 403, `quit from ${origin}`);
    }
    assert.equal(s.state.receiver, null, 'nobody became the receiver');
    const page = await r('/', { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
  } finally { close(); }
});

test('the PC window reporting that it waits for permission shows up in health', async () => {
  const { s, r, close } = await boot();
  let sse;
  try {
    sse = await openSse(s.receiverPort, () => {});
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: false, needsPermission: true } });
    assert.equal((await r('/api/health')).json.needsPermission, true);
    await r('/api/rstatus', { method: 'POST', body: { deviceFound: true } });
    assert.equal((await r('/api/health')).json.needsPermission, false);
  } finally { sse?.destroy(); close(); }
});

test('which microphone a test listens to is not a setting: the PC window is never told one', async () => {
  const { r, close } = await boot({ captureDeviceMatch: 'Webcam Microphone' }); // a setting from an earlier version, or someone trying
  try {
    const cfg = (await r('/api/rconfig')).json;
    assert.equal(cfg.outputDeviceMatch, 'Steam Streaming Microphone');
    assert.ok(!JSON.stringify(cfg).includes('Webcam'), 'the setting is not passed on');
    assert.ok(!('captureDeviceMatch' in loadConfig()), 'and it is not a known setting');
  } finally { close(); }
});
