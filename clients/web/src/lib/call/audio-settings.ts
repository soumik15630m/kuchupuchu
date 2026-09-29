/** The browser's own microphone processing, as a stored preference.
 *
 * Deliberately not a third-party denoiser. Chrome, Safari and Firefox all
 * implement these constraints, they cost nothing, and they are what "noise
 * suppression" means for a voice call. A model-based denoiser would mean
 * fetching a model from someone else's CDN the moment a call starts, which
 * tells that someone a call is starting — a worse trade than the last few
 * decibels of hiss.
 *
 * All three default on, which is what every other calling app does. They are
 * exposed because each one is occasionally wrong: echo cancellation mangles
 * music, and auto gain makes a quiet room sound like a wind tunnel.
 */
const KEY = "kuchupuchu:call-audio";

export interface CallAudioSettings {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

const DEFAULTS: CallAudioSettings = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
};

export function loadCallAudio(): CallAudioSettings {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    const value = parsed as Partial<CallAudioSettings>;
    return {
      noiseSuppression: value.noiseSuppression ?? DEFAULTS.noiseSuppression,
      echoCancellation: value.echoCancellation ?? DEFAULTS.echoCancellation,
      autoGainControl: value.autoGainControl ?? DEFAULTS.autoGainControl,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveCallAudio(patch: Partial<CallAudioSettings>): CallAudioSettings {
  const next = { ...loadCallAudio(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private browsing; the defaults apply for this session.
  }
  return next;
}

export const CALL_AUDIO_ROWS = [
  {
    key: "noiseSuppression" as const,
    label: "Noise suppression",
    note: "Cuts steady background noise — a fan, traffic, a room's hum.",
  },
  {
    key: "echoCancellation" as const,
    label: "Echo cancellation",
    note: "Stops the other side hearing themselves back. Turn it off to share music.",
  },
  {
    key: "autoGainControl" as const,
    label: "Automatic volume",
    note: "Evens out how loud you are. Can make a quiet room sound hissy.",
  },
];
