"use client";

import { useCallback, useEffect, useState } from "react";

import {
  applyGuardEvent,
  concealReason,
  initialGuardState,
  isCaptureShortcut,
  shouldConceal,
  type GuardState,
} from "./screen-guard.mjs";

/** Wires the screen-guard policy to the DOM events it reacts to.
 *
 * The decisions live in screen-guard.mjs; this only listens. Capture-key
 * handling is deliberately on the capture phase and non-passive so the
 * concealment happens in the same task as the keypress rather than after a
 * render tick -- on the platforms where the key reaches us at all, that
 * margin is the whole point. */
export function useScreenGuard(active: boolean) {
  const [state, setState] = useState<GuardState>(initialGuardState);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      setState(initialGuardState());
      return;
    }

    const onBlur = () => setState((s) => applyGuardEvent(s, { type: "blur" }, Date.now()));
    const onFocus = () => setState((s) => applyGuardEvent(s, { type: "focus" }, Date.now()));
    const onVisibility = () =>
      setState((s) =>
        applyGuardEvent(s, { type: "visibility", visible: !document.hidden }, Date.now())
      );
    const onKey = (e: KeyboardEvent) => {
      if (!isCaptureShortcut(e)) return;
      setState((s) => applyGuardEvent(s, { type: "capture" }, Date.now()));
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);

    // The grace window has to lapse on its own; nothing else ticks.
    const timer = setInterval(() => setNow(Date.now()), 200);

    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      clearInterval(timer);
    };
  }, [active]);

  const reveal = useCallback(
    () => setState((s) => applyGuardEvent(s, { type: "reveal" }, Date.now())),
    []
  );

  return {
    concealed: active ? shouldConceal(state, now) : false,
    reason: concealReason(state),
    reveal,
  };
}

/** Closes off the easy save paths. Not security -- a determined person opens
 * devtools -- but it stops "right click, Save image as" being the obvious
 * first move on a photo someone sent in confidence. */
export function blockSaveGestures(element: HTMLElement | null): () => void {
  if (!element) return () => {};
  const stop = (e: Event) => e.preventDefault();
  element.addEventListener("contextmenu", stop);
  element.addEventListener("dragstart", stop);
  element.addEventListener("copy", stop);
  return () => {
    element.removeEventListener("contextmenu", stop);
    element.removeEventListener("dragstart", stop);
    element.removeEventListener("copy", stop);
  };
}
