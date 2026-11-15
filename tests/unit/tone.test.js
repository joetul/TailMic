import test from 'node:test';
import assert from 'node:assert/strict';
import { TONE_HZ, SILENCE_DB, peakFrequency, classifyTone } from '../../app/web/tone.js';

// The dB spectrum an AnalyserNode would give for a steady sine wave (Blackman window, like the browser).
function spectrumOf(hz, sampleRate = 48000, fftSize = 16384, amplitude = 0.25) {
  const re = new Float64Array(fftSize / 2);
  const im = new Float64Array(fftSize / 2);
  // Only the bins near the tone matter; computing them directly keeps the test fast.
  const centre = Math.round((hz * fftSize) / sampleRate);
  const out = new Float32Array(fftSize / 2).fill(-120);
  for (let k = Math.max(1, centre - 6); k <= Math.min(fftSize / 2 - 1, centre + 6); k++) {
    for (let n = 0; n < fftSize; n++) {
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / fftSize) + 0.08 * Math.cos((4 * Math.PI * n) / fftSize);
      const x = amplitude * Math.sin((2 * Math.PI * hz * n) / sampleRate) * w;
      re[k] += x * Math.cos((2 * Math.PI * k * n) / fftSize);
      im[k] -= x * Math.sin((2 * Math.PI * k * n) / fftSize);
    }
    out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / fftSize || 1e-9);
  }
  return out;
}

test('peakFrequency finds a tone to within 1 Hz, also between two bins and at 44.1 kHz', () => {
  for (const [hz, rate] of [[1000, 48000], [500, 48000], [918.75, 48000], [1001.3, 48000], [1000, 44100], [2000, 44100]]) {
    const p = peakFrequency(spectrumOf(hz, rate), rate, 16384);
    assert.ok(Math.abs(p.hz - hz) < 1, `${hz} Hz at ${rate}: got ${p.hz}`);
    assert.ok(p.db > SILENCE_DB, `a quarter-scale tone is well above the silence level, got ${p.db} dB`);
  }
});

test('peakFrequency ignores hum below 150 Hz and reports silence as silence', () => {
  const s = spectrumOf(1000);
  s[17] = -5; // loud 50 Hz hum
  assert.ok(Math.abs(peakFrequency(s, 48000, 16384).hz - 1000) < 1);
  const quiet = new Float32Array(8192).fill(-Infinity);
  assert.deepEqual(peakFrequency(quiet, 48000, 16384), { hz: 0, db: -Infinity });
});

const many = (hz, db = -20, n = 20) => Array.from({ length: n }, () => ({ hz, db }));

test('classifyTone: the right pitch passes', () => {
  assert.deepEqual(classifyTone(many(1000)), { verdict: 'ok', hz: 1000 });
  assert.equal(classifyTone(many(1004.2)).verdict, 'ok');
  assert.equal(classifyTone(many(985)).verdict, 'ok');
});

test('classifyTone: each format fault is recognised by its pitch', () => {
  assert.deepEqual(classifyTone(many(500)), { verdict: 'half', hz: 500 }, 'stereo read as mono');
  assert.deepEqual(classifyTone(many(TONE_HZ * 44100 / 48000)), { verdict: 'rate_low', hz: 919 }, '48000 Hz read as 44100 Hz');
  assert.equal(classifyTone(many(TONE_HZ * 48000 / 44100)).verdict, 'rate_high', '44100 Hz read as 48000 Hz');
  assert.equal(classifyTone(many(2000)).verdict, 'double', 'mono read as stereo');
  assert.equal(classifyTone(many(459)).verdict, 'other', 'both faults at once is still a fault');
  assert.equal(classifyTone(many(700)).verdict, 'other');
});

test('classifyTone: silence, and a stray click among good measurements', () => {
  assert.deepEqual(classifyTone(many(1000, -90)), { verdict: 'silent', hz: 0 });
  assert.deepEqual(classifyTone([]), { verdict: 'silent', hz: 0 });
  assert.equal(classifyTone([...many(1000, -20, 6), ...many(0, -Infinity, 14)]).verdict, 'silent', 'a tone that is mostly missing');
  assert.equal(classifyTone([...many(500, -20, 17), { hz: 3100, db: -30 }, { hz: 180, db: -40 }, { hz: 0, db: -Infinity }]).verdict, 'half');
});
