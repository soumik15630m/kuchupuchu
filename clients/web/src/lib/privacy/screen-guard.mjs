/** Deterrents against capturing a view-once photo.
 *
 * Read this before extending it: **none of this prevents a screenshot.** The
 * only mechanism that does is a protected display path -- Widevine L1 for DRM
 * video, FLAG_SECURE on Android -- and the web platform exposes neither, for
 * images or for anything else. A phone pointed at the monitor defeats every
 * line of code in this file and always will.
 *
 * What it does do is make the easy captures cost something: the photo is
 * concealed whenever the page stops being the thing in front of the user,
 * which is true of the OS snipping tools (they take focus), of switching
 * windows, and of screen recording that is started after the fact. Saving,
 * dragging and copying the image are closed off separately.
 *
 * The grace window exists because focus flickers for reasons that are not
 * captures -- a notification, a devtools dock. Concealing instantly on every
 * blur makes the viewer unusable; concealing and *staying* concealed until
 * the user deliberately reveals again is the behaviour that survives real use.
 */

export const CONCEAL_GRACE_MS = 400;

/** Keys and chords that are a screenshot on some platform.
 *
 * Catching these is best-effort by construction: the OS consumes Win+Shift+S
 * and the macOS chords before the page ever sees them on most setups, and
 * PrintScreen is not reported at all by some browsers. A miss is the normal
 * case, not a bug -- the focus rule above is what actually carries this. */
export function isCaptureShortcut(event) {
  if (!event) return false;
  const key = event.key ?? "";
  if (key === "PrintScreen" || key === "F13") return true;
  // macOS: Cmd+Shift+3 (whole screen), 4 (region), 5 (recorder).
  if (event.metaKey && event.shiftKey && ["3", "4", "5"].includes(key)) return true;
  // Windows: Win+Shift+S. `metaKey` is the Windows key here.
  if (event.metaKey && event.shiftKey && (key === "s" || key === "S")) return true;
  // Windows: Alt+PrintScreen for the active window.
  if (event.altKey && key === "PrintScreen") return true;
  return false;
}

/** The viewer's concealment state.
 *
 * `revealed` is the user's intent, `focused`/`visible` are the environment,
 * and `capturedAtMs` records a shortcut we managed to observe. Keeping them
 * separate is what lets a reveal survive an unrelated focus flicker while a
 * real capture attempt still latches.
 */
export function initialGuardState() {
  return { revealed: true, focused: true, visible: true, capturedAtMs: null };
}

export function applyGuardEvent(state, event, nowMs) {
  switch (event.type) {
    case "blur":
      // Concealing *and* dropping the reveal is deliberate: coming back to a
      // photo that is still on screen would make every window switch a free
      // capture opportunity.
      return { ...state, focused: false, revealed: false };
    case "focus":
      return { ...state, focused: true };
    case "visibility":
      return event.visible
        ? { ...state, visible: true }
        : { ...state, visible: false, revealed: false };
    case "capture":
      return { ...state, capturedAtMs: nowMs, revealed: false };
    case "reveal":
      return { ...state, revealed: true, capturedAtMs: null };
    default:
      return state;
  }
}

export function shouldConceal(state, nowMs) {
  if (!state.revealed) return true;
  if (!state.visible) return true;
  if (!state.focused) return true;
  if (state.capturedAtMs !== null && nowMs - state.capturedAtMs < CONCEAL_GRACE_MS) return true;
  return false;
}

/** Why the photo is hidden, so the viewer can say something true rather than
 * a generic "hidden". */
export function concealReason(state) {
  if (state.capturedAtMs !== null) return "capture";
  if (!state.visible || !state.focused) return "away";
  if (!state.revealed) return "held";
  return null;
}
