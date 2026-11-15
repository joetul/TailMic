// TailMic tone check: the laptop sends a steady test tone through the PC and
// measures the pitch that comes back from "Microphone (Steam Streaming Microphone)".
// A wrong pitch means the two halves of Steam's device use different audio formats.
// Pure functions (no browser APIs), so the unit tests can run them in Node.

/** The tone the laptop sends, in Hz. */
export const TONE_HZ = 1000;

/** A measurement quieter than this (dB, strongest frequency) counts as silence. */
export const SILENCE_DB = -65;

/**
 * The strongest frequency in a spectrum.
 * `spectrum`: magnitudes in dB, one per frequency bin (AnalyserNode.getFloatFrequencyData);
 * bin k is the frequency k * sampleRate / fftSize.
 * Returns { hz, db }. Looks only between `lo` and `hi` Hz (hum and hiss are ignored).
 */
export function peakFrequency(spectrum, sampleRate, fftSize, lo = 150, hi = 4000) {
  const binHz = sampleRate / fftSize;
  const first = Math.max(1, Math.ceil(lo / binHz));
  const end = Math.min(spectrum.length - 2, Math.floor(hi / binHz));
  let k = -1;
  let best = -Infinity;
  for (let i = first; i <= end; i++) {
    if (spectrum[i] > best) { best = spectrum[i]; k = i; }
  }
  if (k < 0 || !Number.isFinite(best)) return { hz: 0, db: -Infinity };
  // The true peak lies between bins: fit a parabola through the peak and its neighbours.
  const a = spectrum[k - 1];
  const c = spectrum[k + 1];
  const curve = a - 2 * best + c;
  const shift = Number.isFinite(a) && Number.isFinite(c) && curve < 0 ? (0.5 * (a - c)) / curve : 0;
  return { hz: (k + Math.max(-0.5, Math.min(0.5, shift))) * binHz, db: best };
}

/** What each pitch ratio (heard / sent) means. `near` is how far off the ratio may be. */
const FAULTS = [
  { verdict: 'ok', ratio: 1, near: 0.03 },
  // Stereo read as mono (or 96000 Hz read as 48000 Hz): half speed, one octave down.
  { verdict: 'half', ratio: 0.5, near: 0.03 },
  // Mono read as stereo: double speed, one octave up.
  { verdict: 'double', ratio: 2, near: 0.1 },
  // Played at 48000 Hz, recorded at 44100 Hz: about 8% slow and low.
  { verdict: 'rate_low', ratio: 44100 / 48000, near: 0.02 },
  // Played at 44100 Hz, recorded at 48000 Hz: about 9% fast and high.
  { verdict: 'rate_high', ratio: 48000 / 44100, near: 0.02 },
];

/**
 * Judge a tone check from several measurements ({ hz, db } each, see peakFrequency).
 * Returns { verdict, hz } where hz is the pitch that came back (0 when silent) and
 * verdict is 'ok', 'half', 'double', 'rate_low', 'rate_high', 'silent' or 'other'.
 */
export function classifyTone(samples, sentHz = TONE_HZ) {
  const heard = samples.filter((s) => s && s.db > SILENCE_DB && s.hz > 0).map((s) => s.hz).sort((x, y) => x - y);
  // The tone is steady, so it must be there in most measurements.
  if (!samples.length || heard.length < samples.length / 2) return { verdict: 'silent', hz: 0 };
  const hz = heard[Math.floor(heard.length / 2)]; // the median ignores a stray click
  const ratio = hz / sentHz;
  const fault = FAULTS.find((f) => Math.abs(ratio - f.ratio) <= f.near);
  return { verdict: fault ? fault.verdict : 'other', hz: Math.round(hz) };
}
