export const WAVEFORM_BARS: number;
export const PLAYBACK_RATES: number[];

/** Normalised peaks in 0..1, one per bar. */
export function peaksFrom(samples: Float32Array | number[] | null, bars?: number): number[];

export function nextPlaybackRate(current: number): number;
