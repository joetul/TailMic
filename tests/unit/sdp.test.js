import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedAddress, isAllowedEndpoint, sameIP, parseCidr, filterCandidates, mungeOpus, TAILSCALE_CIDRS, selectedPair } from '../../app/web/sdp.js';

test('Tailscale IPv4/IPv6 addresses are allowed', () => {
  for (const a of ['100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', '[fd7a:115c:a1e0::5]']) {
    assert.equal(isAllowedAddress(a, TAILSCALE_CIDRS), true, a);
  }
});

test('LAN, public, loopback, mDNS and junk are refused', () => {
  for (const a of ['192.168.1.20', '10.0.0.5', '172.17.0.2', '100.63.255.255', '100.128.0.1', '8.8.8.8', '127.0.0.1', '::1',
    'fe80::1', 'fd7a:115c:a1e1::1', '2001:db8::1', 'abcd-1234.local', '', 'not-an-ip', '1.2.3', '300.1.1.1', '::ffff:100.64.0.1']) {
    assert.equal(isAllowedAddress(a, TAILSCALE_CIDRS), false, a);
  }
});

test('parseCidr rejects bad input', () => {
  assert.equal(parseCidr('100.64.0.0/33'), null);
  assert.equal(parseCidr('nonsense/8'), null);
  assert.ok(parseCidr('100.64.0.0/10'));
});

const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=audio 51000 UDP/TLS/RTP/SAVPF 111 63 9', 'c=IN IP4 192.168.1.20', 'a=rtcp:9 IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.20 51000 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 100.101.1.2 51001 typ host generation 0',
  'a=candidate:3 1 udp 2122129151 fd7a:115c:a1e0::12 51002 typ host generation 0',
  'a=candidate:4 1 udp 2122063615 1f0a2b3c-aaaa-bbbb-cccc-1234567890ab.local 51003 typ host generation 0',
  'a=candidate:5 1 udp 1686052607 85.1.2.3 51004 typ srflx raddr 192.168.1.20 rport 51000',
  'a=candidate:6 1 tcp 1518280447 10.0.0.4 9 typ host tcptype active',
  'a=ice-ufrag:abcd', 'a=mid:0', 'a=sendonly',
  'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2', 'a=rtpmap:9 G722/8000', '',
].join('\r\n');

test('filterCandidates keeps only Tailscale candidates and hides LAN addresses', () => {
  const f = filterCandidates(OFFER, TAILSCALE_CIDRS);
  assert.deepEqual(f.kept, ['100.101.1.2', 'fd7a:115c:a1e0::12']);
  assert.equal(f.dropped, 4);
  assert.ok(!f.sdp.includes('192.168.1.20'));
  assert.ok(!f.sdp.includes('85.1.2.3'));
  assert.ok(!f.sdp.includes('.local'));
  assert.ok(f.sdp.includes('c=IN IP4 0.0.0.0'));
  assert.ok(f.sdp.endsWith('\r\n') && !f.sdp.endsWith('\r\n\r\n'));
});

test('filterCandidates with no Tailscale candidates keeps nothing', () => {
  const f = filterCandidates(OFFER.replace(/100\.101\.1\.2/, '192.168.1.21').replace('fd7a:115c:a1e0::12', 'fe80::12'), TAILSCALE_CIDRS);
  assert.equal(f.kept.length, 0);
  assert.ok(!/a=candidate/.test(f.sdp));
});

test('mungeOpus sets mono, FEC, no DTX, bitrate and 10 ms ptime', () => {
  const s = mungeOpus(OFFER, { maxaveragebitrate: 128000, ptime: 10 });
  const fmtp = s.match(/^a=fmtp:111 (.*)$/m)[1];
  const p = Object.fromEntries(fmtp.split(';').map((kv) => kv.split('=')));
  assert.deepEqual(p, { minptime: '10', useinbandfec: '1', usedtx: '0', stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: '128000' });
  assert.match(s, /^a=ptime:10$/m);
  assert.equal((s.match(/^a=ptime:/gm) || []).length, 1);
  // Idempotent
  assert.equal(mungeOpus(s), s);
});

test('mungeOpus adds fmtp if missing', () => {
  const s = mungeOpus(OFFER.replace(/a=fmtp:111 .*\r\n/, ''));
  assert.match(s, /a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 [^\r]*usedtx=0/);
});

test('selectedPair reads the transport-selected pair', () => {
  const stats = new Map([
    ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
    ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.004 }],
    ['L', { id: 'L', type: 'local-candidate', address: '100.1.2.3', candidateType: 'host' }],
    ['R', { id: 'R', type: 'remote-candidate', address: '100.4.5.6', candidateType: 'host' }],
  ]);
  assert.deepEqual(selectedPair(stats), { local: '100.1.2.3', remote: '100.4.5.6', localType: 'host', remoteType: 'host', rtt: 0.004 });
});

test('exact PC IPs: only those addresses pass, IPv6 spelling does not matter', () => {
  const exact = ['100.100.9.9', 'fd7a:115c:a1e0::9'];
  assert.equal(isAllowedEndpoint('100.100.9.9', TAILSCALE_CIDRS, exact), true);
  assert.equal(isAllowedEndpoint('fd7a:115c:a1e0:0:0:0:0:9', TAILSCALE_CIDRS, exact), true);
  assert.equal(isAllowedEndpoint('100.70.0.5', TAILSCALE_CIDRS, exact), false);
  assert.equal(isAllowedEndpoint('100.70.0.5', TAILSCALE_CIDRS, []), true, 'no list: range only');
  assert.equal(isAllowedEndpoint('192.168.1.2', TAILSCALE_CIDRS, ['192.168.1.2']), false, 'list never widens the range');
  assert.equal(sameIP('FD7A:115C:A1E0::9', 'fd7a:115c:a1e0:0::9'), true);
});

test('kept candidates lose their related (LAN) address', () => {
  const sdp = OFFER + 'a=candidate:7 1 udp 1 100.101.1.9 5009 typ prflx raddr 192.168.1.20 rport 51000\r\n';
  const f = filterCandidates(sdp, TAILSCALE_CIDRS);
  assert.ok(f.sdp.includes('100.101.1.9 5009 typ prflx raddr 0.0.0.0 rport 0'));
  assert.ok(!f.sdp.includes('192.168.1.20'));
});
