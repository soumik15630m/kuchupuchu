// Peak extraction for voice-note waveforms.
//
// Pure given decoded samples, so the bucketing is testable without an
// AudioContext — decoding is the caller's job.

export const WAVEFORM_BARS = 40;

/**
 * Reduces raw samples to `bars` normalised peaks in 0..1.
 *
 * Peak rather than RMS per bucket: speech is mostly quiet with short loud
 * bursts, and averaging flattens it into a featureless strip.
 *
 * @param {Float32Array|number[]} samples
 * @param {number} bars
 * @returns {number[]}
 */
export function peaksFrom(samples, bars = WAVEFORM_BARS) {
  if (!samples || samples.length === 0) return new Array(bars).fill(0);

  const bucketSize = Math.max(1, Math.floor(samples.length / bars));
  const peaks = [];
  for (let i = 0; i < bars; i++) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, samples.length);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const value = Math.abs(samples[j]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
  }

  // Normalised against the loudest bar, so a quietly-recorded note still
  // renders as a readable shape rather than a flat line.
  const loudest = Math.max(...peaks);
  if (loudest <= 0) return peaks.map(() => 0);
  return peaks.map((p) => p / loudest);
}

export const PLAYBACK_RATES = [1, 1.5, 2];

export function nextPlaybackRate(current) {
  const index = PLAYBACK_RATES.indexOf(current);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}
