// TailMic shared helpers: IP range checks, ICE candidate filtering and Opus
// SDP tuning. This one file is used by the Node server AND by both web pages,
// so the "Tailscale addresses only" rule is implemented exactly once.

/** Default: Tailscale's IPv4 (CGNAT) and IPv6 ranges. */
export const TAILSCALE_CIDRS = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

function parseIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseIPv6(input) {
  let s = input.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!s.includes(':')) return null;
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = parseIPv4(v4[2]);
    if (n === null) return null;
    s = v4[1] + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Parse an IP address. Returns {v: 4|6, n: BigInt} or null. */
export function parseIP(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  const a = addr.trim();
  if (a.includes(':')) {
    const n = parseIPv6(a);
    return n === null ? null : { v: 6, n };
  }
  const n = parseIPv4(a);
  return n === null ? null : { v: 4, n };
}

/** Parse "a.b.c.d/len" or "x::/len". Returns {v, net, bits} or null. */
export function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const [addr, lenStr] = cidr.trim().split('/');
  const ip = parseIP(addr);
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const bits = lenStr === undefined ? width : Number(lenStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const shift = BigInt(width - bits);
  return { v: ip.v, net: (ip.n >> shift) << shift, bits, width };
}

/** True if two IP strings are the same address (handles IPv6 spelling differences). */
export function sameIP(a, b) {
  const x = parseIP(a);
  const y = parseIP(b);
  return !!(x && y && x.v === y.v && x.n === y.n);
}

/**
 * True if `addr` is allowed: inside one of `cidrs` and, when `exact` lists any
 * IPs (the PC's own Tailscale addresses), equal to one of them.
 */
export function isAllowedEndpoint(addr, cidrs = TAILSCALE_CIDRS, exact = []) {
  if (!isAllowedAddress(addr, cidrs)) return false;
  return !exact || !exact.length || exact.some((e) => sameIP(e, addr));
}

/** True if `addr` is a literal IP inside one of `cidrs`. Hostnames (mDNS .local) are never allowed. */
export function isAllowedAddress(addr, cidrs = TAILSCALE_CIDRS) {
  const ip = parseIP(addr);
  if (!ip) return false;
  for (const c of cidrs) {
    const r = parseCidr(c);
    if (!r || r.v !== ip.v) continue;
    const shift = BigInt(r.width - r.bits);
    if ((ip.n >> shift) << shift === r.net) return true;
  }
  return false;
}

/**
 * Parse one "a=candidate:..." (or "candidate:...") line.
 * Returns {address, port, protocol, type} or null.
 */
export function parseCandidate(line) {
  const s = String(line).replace(/^a=/, '');
  if (!s.startsWith('candidate:')) return null;
  const p = s.slice('candidate:'.length).trim().split(/\s+/);
  if (p.length < 8 || p[6] !== 'typ') return null;
  return { address: p[4], port: Number(p[5]), protocol: p[2].toLowerCase(), type: p[7] };
}

/**
 * Remove every ICE candidate whose address is not allowed (see isAllowedEndpoint),
 * blank the related-address fields of the kept ones, and blank the
 * connection-address lines, so no LAN address is left in the SDP that is sent.
 * (The browser that made the SDP still knows its own LAN addresses, but the
 * other side never learns them, so it can only send audio to Tailscale addresses.)
 * Returns {sdp, kept: [addr...], dropped: number}.
 */
export function filterCandidates(sdp, cidrs = TAILSCALE_CIDRS, exact = []) {
  const lines = String(sdp).split(/\r?\n/);
  const out = [];
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) {
      const c = parseCandidate(line);
      if (c && isAllowedEndpoint(c.address, cidrs, exact)) {
        out.push(line.replace(/ raddr \S+ rport \d+/, ' raddr 0.0.0.0 rport 0'));
        kept.push(c.address);
      } else {
        dropped++;
      }
      continue;
    }
    if (/^c=IN IP[46] /.test(line)) {
      out.push('c=IN IP4 0.0.0.0');
      continue;
    }
    if (/^a=rtcp:\d+ IN IP[46] /.test(line)) {
      out.push(line.replace(/ IN IP[46] .*$/, ' IN IP4 0.0.0.0'));
      continue;
    }
    out.push(line);
  }
  // Keep exactly one trailing CRLF.
  while (out.length && out[out.length - 1] === '') out.pop();
  return { sdp: out.join('\r\n') + '\r\n', kept, dropped };
}

/**
 * Tune Opus in an SDP for clean, low-latency voice: mono, in-band FEC,
 * no DTX (DTX can clip word starts), 10 ms packets, high bitrate.
 * Apply it to the SDP that describes what the *receiver* wants, i.e. the
 * answer the sender passes to setRemoteDescription (and the offer, too).
 */
export function mungeOpus(sdp, { maxaveragebitrate = 128000, ptime = 10 } = {}) {
  const text = String(sdp);
  const m = text.match(/^a=rtpmap:(\d+) opus\/48000(?:\/2)?\s*$/im);
  if (!m) return text;
  const pt = m[1];
  const want = {
    minptime: String(Math.min(ptime, 10)),
    useinbandfec: '1',
    usedtx: '0',
    stereo: '0',
    'sprop-stereo': '0',
    maxaveragebitrate: String(maxaveragebitrate),
  };
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (fmtpIdx >= 0) {
    const params = new Map();
    for (const kv of lines[fmtpIdx].slice(`a=fmtp:${pt} `.length).split(';')) {
      const [k, ...v] = kv.trim().split('=');
      if (k) params.set(k, v.join('='));
    }
    for (const [k, v] of Object.entries(want)) params.set(k, v);
    lines[fmtpIdx] = `a=fmtp:${pt} ` + [...params].map(([k, v]) => `${k}=${v}`).join(';');
  } else {
    const rtpIdx = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    lines.splice(rtpIdx + 1, 0, `a=fmtp:${pt} ` + Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';'));
  }

  // a=ptime inside the audio m-section.
  const mStart = lines.findIndex((l) => l.startsWith('m=audio'));
  if (mStart >= 0) {
    let mEnd = lines.findIndex((l, i) => i > mStart && l.startsWith('m='));
    if (mEnd < 0) mEnd = lines.length;
    const pIdx = lines.findIndex((l, i) => i > mStart && i < mEnd && l.startsWith('a=ptime:'));
    if (pIdx >= 0) lines[pIdx] = `a=ptime:${ptime}`;
    else {
      const f = lines.findIndex((l, i) => i > mStart && i < mEnd && l.startsWith(`a=fmtp:${pt} `));
      lines.splice(f + 1, 0, `a=ptime:${ptime}`);
    }
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * From an RTCStatsReport (as an array/Map of stats), return the selected ICE
 * pair: {local, remote, rtt, localType, remoteType} or null.
 */
export function selectedPair(report) {
  const all = new Map();
  report.forEach((s) => all.set(s.id, s));
  let pair = null;
  for (const s of all.values()) {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId);
  }
  if (!pair) {
    for (const s of all.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
    }
  }
  if (!pair) return null;
  const l = all.get(pair.localCandidateId) || {};
  const r = all.get(pair.remoteCandidateId) || {};
  return {
    local: l.address || l.ip || '',
    remote: r.address || r.ip || '',
    localType: l.candidateType,
    remoteType: r.candidateType,
    rtt: pair.currentRoundTripTime,
  };
}
