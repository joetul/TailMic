// TailMic server: tiny signaling + static file server. No dependencies.
//
// Two HTTP listeners, both bound to 127.0.0.1 only (never the LAN):
//   * client port (default 8470): reached ONLY through `tailscale serve`
//     (HTTPS on the tailnet). Every request must carry the Tailscale-User-Login
//     header that Tailscale Serve adds, and it must be an allowed user.
//   * receiver port (default 8471): the receiver page opened by Chrome or Edge on this PC.
//
// Audio itself never passes through this server: it flows directly between the
// two browsers (WebRTC, DTLS-SRTP). Each browser is only ever told the other's
// Tailscale addresses: every other ICE candidate is removed here, and the PC's
// side is pinned to the PC's exact Tailscale IPs (from `tailscale ip`).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterCandidates } from './web/sdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const MAX_BODY = 64 * 1024;
const MAX_DISCARD = 1024 * 1024; // after refusing a big body, read at most this much more, then cut the connection
const ANSWER_TIMEOUT_MS = 15000;

export function loadConfig(file) {
  const defaults = JSON.parse(fs.readFileSync(path.join(HERE, 'config.default.json'), 'utf8'));
  let user = {};
  if (file && fs.existsSync(file)) {
    // Strip a UTF-8 BOM (Windows PowerShell 5.1 likes to write one).
    user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  const cfg = { ...defaults, ...user, opus: { ...defaults.opus, ...(user.opus || {}) } };
  cfg.allowedUsers = [].concat(cfg.allowedUsers || []).map((u) => String(u).trim().toLowerCase()).filter(Boolean);
  return cfg;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * Log at most `max` lines per `windowMs` for each key (e.g. a web page that keeps
 * retrying a refused request), then one summary line. Keys are few and fixed
 * (request kind / Tailscale login), so the map stays tiny.
 */
export function makeLimitedLog(write = log, max = 5, windowMs = 60000, now = Date.now) {
  const seen = new Map();
  return (key, ...msg) => {
    const t = now();
    let e = seen.get(key);
    if (!e || t - e.start >= windowMs) {
      if (e && e.suppressed) write(`(${e.suppressed} more "${key}" messages suppressed)`);
      e = { start: t, count: 0, suppressed: 0 };
      seen.set(key, e);
    }
    if (e.count < max) { e.count++; write(...msg); } else e.suppressed++;
  };
}

/**
 * The PC's own Tailscale IPs, read with `tailscale ip` (cached for 30 s).
 * Returns [] if Tailscale is not available; the address-range filter still applies then.
 */
export function makePcIps(tailscaleExe, ttlMs = 30000) {
  let cache = { at: 0, ips: [] };
  return () => new Promise((resolve) => {
    if (!tailscaleExe) return resolve([]);
    if (Date.now() - cache.at < ttlMs) return resolve(cache.ips);
    execFile(tailscaleExe, ['ip'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      const ips = err ? [] : String(stdout).split(/\s+/).filter((x) => /^[0-9a-f.:]+$/i.test(x));
      if (err) log('could not read Tailscale IPs:', err.message);
      cache = { at: ips.length ? Date.now() : 0, ips };
      resolve(ips);
    });
  });
}

const STATIC = {
  client: { '/': 'client.html', '/client.js': 'client.js', '/sdp.js': 'sdp.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' },
  receiver: { '/': 'receiver.html', '/receiver.js': 'receiver.js', '/sdp.js': 'sdp.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Permissions-Policy': 'microphone=(self), speaker-selection=(self), camera=(), geolocation=()',
    ...extra,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }));
  res.end(body);
}

function serveStatic(table, req, res) {
  const url = new URL(req.url, 'http://x');
  const name = table[url.pathname];
  if (!name || req.method !== 'GET') return false;
  const file = path.join(WEB, name);
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, baseHeaders({ 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream' }));
    res.end(data);
  });
  return true;
}

function readJson(req, res) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json')) return reject(Object.assign(new Error('json required'), { status: 415 }));
    let size = 0;
    let over = false;
    const chunks = [];
    // Refuse a too-big body: answer 413, close the connection afterwards, and cut
    // it off hard if the sender keeps going (more than 1 MB extra or 5 seconds).
    const refuse = () => {
      over = true;
      chunks.length = 0;
      res.setHeader('Connection', 'close');
      const t = setTimeout(() => req.destroy(), 5000);
      req.once('close', () => clearTimeout(t));
      req.once('end', () => clearTimeout(t));
      reject(Object.assign(new Error('too large'), { status: 413 }));
    };
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) refuse();
    req.on('data', (c) => {
      size += c.length;
      if (over) {
        if (size > MAX_BODY + MAX_DISCARD) req.destroy();
        return;
      }
      if (size > MAX_BODY) refuse();
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

export function createTailMic(cfg, { onQuit = () => {} } = {}) {
  const limitedLog = makeLimitedLog();
  const pcIps = makePcIps(cfg.tailscaleExe);
  const state = {
    receiver: null, // { res, id, pingTimer }
    receiverStatus: { deviceFound: false, deviceLabel: '', state: 'offline', updated: 0 },
    session: null, // { id, user, pending: {resolve}|null }
  };

  function sse(event, data) {
    if (!state.receiver) return false;
    state.receiver.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  // ---------- client side (behind tailscale serve) ----------
  function deny(req, res, status, obj) {
    if (req.url.startsWith('/api/')) return sendJson(res, status, obj);
    // Human-readable page for the browser address bar.
    const msg = String(obj.message || 'Access denied.').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TailMic - not allowed</title><body style="font-family:system-ui;margin:40px;max-width:520px"><h1>TailMic</h1><p>${msg}</p></body>`;
    res.writeHead(status, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }));
    res.end(body);
  }

  // Host header allowed on the client port: the PC's own *.ts.net name (from
  // Setup/Start) or the loopback address Tailscale Serve forwards to. Blocks DNS
  // rebinding from a web page opened in a browser on the PC.
  function clientHostOk(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const name = host.replace(/:\d+$/, '');
    if (host === `127.0.0.1:${cfg.clientPort}` || host === `localhost:${cfg.clientPort}`) return true;
    const want = String(cfg.serveHost || '').toLowerCase().replace(/\.$/, '');
    return want ? name === want : name.endsWith('.ts.net');
  }

  function authClient(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'forbidden' });
      return null;
    }
    if (!clientHostOk(req)) {
      limitedLog('badhost', `refused request for host ${String(req.headers.host).slice(0, 100)}`);
      deny(req, res, 403, { error: 'wrong_host', message: 'Open TailMic using the PC\'s https://...ts.net address.' });
      return null;
    }
    const login = String(req.headers['tailscale-user-login'] || '').trim().toLowerCase();
    if (!login) {
      deny(req, res, 403, { error: 'no_tailscale_identity', message: 'Open TailMic through its https://<pc>.ts.net address from one of your own (non-tagged) Tailscale devices.' });
      return null;
    }
    if (!cfg.allowedUsers.includes(login)) {
      limitedLog(`denied:${login}`, 'DENIED tailscale user', login);
      deny(req, res, 403, { error: 'user_not_allowed', message: `Tailscale user ${login} is not allowed on this PC.` });
      return null;
    }
    if (req.method === 'POST') {
      // Browsers always send Sec-Fetch-Site; a cross-site page cannot fake it.
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin') {
        sendJson(res, 403, { error: 'cross_site' });
        return null;
      }
    }
    return login;
  }

  async function onClient(req, res) {
    const url = new URL(req.url, 'http://x');
    const user = authClient(req, res);
    if (!user) return;
    if (serveStatic(STATIC.client, req, res)) return;

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, {
        user,
        allowedCidrs: cfg.allowedCidrs,
        pcIps: await pcIps(),
        opus: cfg.opus,
        receiverOnline: !!state.receiver,
        receiver: state.receiverStatus,
        activeSession: state.session ? state.session.id : null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/offer') {
      let body;
      try { body = await readJson(req, res); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
      if (typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) return sendJson(res, 400, { error: 'bad_sdp' });
      if (!state.receiver) return sendJson(res, 503, { error: 'receiver_offline', message: 'TailMic is not running on the PC (start it with Start-TailMic).' });
      if (!state.receiverStatus.deviceFound) {
        return sendJson(res, 503, { error: 'no_output_device', message: 'The PC cannot find "Speakers (Steam Streaming Microphone)". Is Steam running?' });
      }
      const f = filterCandidates(body.sdp, cfg.allowedCidrs);
      if (!f.kept.length) {
        return sendJson(res, 400, { error: 'no_tailscale_candidates', message: 'Your browser offered no Tailscale address. Is Tailscale connected on this computer?' });
      }
      // Replace any previous session.
      if (state.session) {
        sse('hangup', { id: state.session.id, reason: 'replaced' });
        state.session.pending?.resolve({ status: 409, body: { error: 'replaced' } });
      }
      const id = crypto.randomUUID();
      const session = { id, user, pending: null, since: Date.now() };
      state.session = session;
      log(`offer from ${user} session=${id.slice(0, 8)} candidates=${f.kept.join(',')} dropped=${f.dropped}`);
      let timer;
      // The laptop may leave (tab closed, network gone) while the PC is answering:
      // then cancel the call instead of leaving the PC waiting on a dead peer.
      let gone = false;
      const onClose = () => {
        if (res.writableEnded) return;
        gone = true;
        session.pending?.resolve({ status: 499, body: { error: 'client_gone' } });
      };
      res.on('close', onClose);
      const result = await new Promise((resolve) => {
        session.pending = { resolve };
        sse('offer', { id, user, sdp: f.sdp });
        timer = setTimeout(() => resolve({ status: 504, body: { error: 'receiver_timeout', message: 'The PC did not answer in time.' } }), ANSWER_TIMEOUT_MS);
      });
      clearTimeout(timer);
      res.off('close', onClose);
      session.pending = null;
      if (gone || res.destroyed) {
        if (state.session === session) {
          log(`laptop left during set-up, cancelling session=${id.slice(0, 8)}`);
          sse('hangup', { id, reason: 'client' });
          state.session = null;
        }
        return;
      }
      if (result.status !== 200 && state.session === session) {
        sse('hangup', { id, reason: 'failed' });
        state.session = null;
      }
      return sendJson(res, result.status, result.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/hangup') {
      let body;
      try { body = await readJson(req, res); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
      if (state.session && body.id === state.session.id) {
        log(`hangup from ${user} session=${String(body.id).slice(0, 8)}`);
        state.session.pending?.resolve({ status: 409, body: { error: 'hung_up' } });
        sse('hangup', { id: body.id, reason: 'client' });
        state.session = null;
      }
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  // ---------- receiver side (local Chrome/Edge window on the PC) ----------
  function authReceiver(req, res) {
    const host = String(req.headers.host || '');
    const okHost = host === `127.0.0.1:${cfg.receiverPort}` || host === `localhost:${cfg.receiverPort}`;
    if (!isLoopback(req.socket.remoteAddress) || !okHost) {
      sendJson(res, 403, { error: 'forbidden' });
      return false;
    }
    // Every request (GET too) must come from TailMic's own receiver window:
    // 'none' = the window opening the page directly, 'same-origin' = the page's
    // own scripts. This stops any other website open in a browser on the PC
    // (including other localhost ports, which count as 'same-site') from opening
    // the event stream or the page and taking over as "the receiver".
    // Browsers always send this header; only local non-browser tools omit it.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      limitedLog(`refused:${site}`, `refused ${site} request to receiver: ${req.method} ${req.url}`);
      sendJson(res, 403, { error: 'cross_site' });
      return false;
    }
    if (req.method === 'POST' && site === 'none') {
      sendJson(res, 403, { error: 'cross_site' });
      return false;
    }
    return true;
  }

  async function onReceiver(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!authReceiver(req, res)) return;
    if (serveStatic(STATIC.receiver, req, res)) return;

    // ----- for the start/stop/status scripts (also usable over SSH) -----
    // Local command-line tools only: browsers always send Sec-Fetch-Site, so no
    // web page (not even TailMic's own) can stop TailMic.
    const localTool = req.headers['sec-fetch-site'] === undefined;

    if (req.method === 'GET' && url.pathname === '/api/health') {
      if (!localTool && req.headers['sec-fetch-site'] !== 'same-origin') return sendJson(res, 403, { error: 'forbidden' });
      const st = state.receiverStatus;
      return sendJson(res, 200, {
        server: true,
        receiverWindow: !!state.receiver,
        outputDevice: st.deviceFound ? st.deviceLabel : null,
        call: state.session ? { user: state.session.user, state: st.state, since: new Date(state.session.since).toISOString() } : null,
        allowedUsers: cfg.allowedUsers,
        serveHost: cfg.serveHost || null,
        httpsPort: cfg.httpsPort,
        pcIps: await pcIps(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/quit') {
      if (!localTool) return sendJson(res, 403, { error: 'forbidden' });
      try { await readJson(req, res); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
      log('stop requested: closing the receiver window and the server');
      if (state.session) {
        state.session.pending?.resolve({ status: 503, body: { error: 'receiver_offline', message: 'TailMic was stopped on the PC.' } });
        state.session = null;
      }
      const hadWindow = sse('quit', {});
      sendJson(res, 200, { ok: true, receiverWindow: hadWindow });
      // Give the window a moment to receive "quit" and close itself.
      setTimeout(() => onQuit(), 1500);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/rconfig') {
      return sendJson(res, 200, {
        allowedCidrs: cfg.allowedCidrs,
        outputDeviceMatch: cfg.outputDeviceMatch,
        outputDeviceExclude: cfg.outputDeviceExclude,
        allowedUsers: cfg.allowedUsers,
        httpsPort: cfg.httpsPort,
        pcIps: await pcIps(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (state.receiver) {
        // Tell the old window it was replaced, so it stops reconnecting instead of
        // two TailMic windows taking turns.
        clearInterval(state.receiver.pingTimer);
        state.receiver.res.end('event: replaced\ndata: {}\n\n');
      }
      res.writeHead(200, baseHeaders({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }));
      res.write('retry: 2000\n\n');
      const rec = { res, pingTimer: setInterval(() => res.write(': ping\n\n'), 15000) };
      state.receiver = rec;
      log('receiver connected');
      req.on('close', () => {
        clearInterval(rec.pingTimer);
        if (state.receiver === rec) {
          state.receiver = null;
          state.receiverStatus = { ...state.receiverStatus, state: 'offline' };
          log('receiver disconnected');
        }
      });
      sse('hello', { allowedUsers: cfg.allowedUsers });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/answer') {
      let body;
      try { body = await readJson(req, res); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
      const s = state.session;
      if (!s || s.id !== body.id || !s.pending) return sendJson(res, 410, { error: 'no_such_session' });
      if (body.error) {
        s.pending.resolve({ status: 502, body: { error: body.error, message: body.message || 'The PC could not accept the call.' } });
        return sendJson(res, 200, { ok: true });
      }
      if (typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) return sendJson(res, 400, { error: 'bad_sdp' });
      const f = filterCandidates(body.sdp, cfg.allowedCidrs, await pcIps());
      if (!s.pending) return sendJson(res, 410, { error: 'no_such_session' }); // ended while we looked up the IPs
      if (!f.kept.length) {
        s.pending.resolve({ status: 502, body: { error: 'receiver_no_tailscale', message: 'The PC has no Tailscale address visible to its browser. Is Tailscale connected on the PC?' } });
        return sendJson(res, 200, { ok: false });
      }
      log(`answer session=${s.id.slice(0, 8)} candidates=${f.kept.join(',')} dropped=${f.dropped}`);
      s.pending.resolve({ status: 200, body: { id: s.id, sdp: f.sdp } });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/ended') {
      // The PC window dropped a call (failed, blocked, or replaced): forget it.
      let body;
      try { body = await readJson(req, res); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
      if (state.session && state.session.id === body.id && !state.session.pending) {
        log(`PC ended session=${String(body.id).slice(0, 8)}`);
        state.session = null;
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/rstatus') {
      let body;
      try { body = await readJson(req, res); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
      state.receiverStatus = {
        deviceFound: !!body.deviceFound,
        deviceLabel: String(body.deviceLabel || '').slice(0, 200),
        state: String(body.state || '').slice(0, 40),
        updated: Date.now(),
      };
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((e) => {
      log('error', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    });
  };

  return {
    state,
    clientServer: http.createServer(wrap(onClient)),
    receiverServer: http.createServer(wrap(onReceiver)),
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

export async function start(cfg, hooks) {
  const app = createTailMic(cfg, hooks);
  const clientPort = await listen(app.clientServer, cfg.clientPort, cfg.bindAddress);
  const receiverPort = await listen(app.receiverServer, cfg.receiverPort, cfg.bindAddress);
  return { ...app, clientPort, receiverPort };
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const cfgFile = arg('--config') || process.env.TAILMIC_CONFIG;
  const logFile = arg('--log');
  const tailscaleArg = arg('--tailscale'); // path to tailscale.exe, used to read the PC's own Tailscale IPs
  const serveHostArg = arg('--serve-host'); // this PC's *.ts.net name
  if (logFile) {
    // Append (never overwrite) so a restart on the same day keeps earlier lines.
    // Synchronous on purpose: TailMic logs only a few lines per call, and a
    // fatal start-up error must reach the file before the process exits.
    const line = (a) => fs.appendFileSync(logFile, a.map((x) => (typeof x === 'string' ? x : (x instanceof Error ? x.stack : JSON.stringify(x)))).join(' ') + '\n');
    // (If the log file cannot be written, Node's stderr still gets the error.)
    console.log = (...a) => line(a);
    console.error = (...a) => line(a);
  }
  const cfg = loadConfig(cfgFile);
  if (tailscaleArg) cfg.tailscaleExe = tailscaleArg;
  if (serveHostArg) cfg.serveHost = serveHostArg;
  if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.bindAddress) && !process.env.TAILMIC_ALLOW_NON_LOOPBACK) {
    console.error('Refusing to bind to a non-loopback address. TailMic must only be reached through Tailscale Serve.');
    process.exit(2);
  }
  if (!cfg.allowedUsers.length) {
    console.error('WARNING: no allowedUsers configured - every client request will be refused. Run Setup-TailMic.');
  }
  let running = null;
  const quit = () => {
    log('TailMic server stopped.');
    running?.clientServer.close();
    running?.receiverServer.close();
    setTimeout(() => process.exit(0), 200);
  };
  start(cfg, { onQuit: quit }).then(
    (s) => (running = s) && log(`TailMic listening: client 127.0.0.1:${s.clientPort} (via tailscale serve), receiver http://127.0.0.1:${s.receiverPort}/ ; allowed users: ${cfg.allowedUsers.join(', ') || '(none)'}`),
    (e) => {
      console.error(e.code === 'EADDRINUSE' ? `Port already in use (${e.port}). Is TailMic already running?` : e);
      process.exit(1);
    },
  );
}
