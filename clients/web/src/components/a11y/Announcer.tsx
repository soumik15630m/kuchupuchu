"use client";

import { useEffect, useRef, useState } from "react";

import { COALESCE_MS, coalesce } from "@/lib/a11y/announce.mjs";

import styles from "./Announcer.module.css";

/** The one live region for the whole app.
 *
 * One rather than one per screen, because two live regions competing produce
 * interleaved speech that is worse than either alone. `polite` rather than
 * `assertive`: an arriving message should wait for the reader to finish the
 * sentence they are on, not cut into it.
 *
 * Bursts are collapsed -- see announce.mjs. The text is cleared shortly after
 * being set so that the *same* message arriving twice is announced twice; a
 * live region only speaks when its content changes.
 */
export function Announcer({ message }: { message: string | null }) {
  const [spoken, setSpoken] = useState("");
  const pending = useRef(0);
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!message) return;
    pending.current += 1;
    latest.current = message;
    if (timer.current) return;

    timer.current = setTimeout(() => {
      timer.current = null;
      const text = coalesce(pending.current, latest.current);
      pending.current = 0;
      if (text) setSpoken(text);
      // Cleared so an identical next announcement still changes the content.
      setTimeout(() => setSpoken(""), 1200);
    }, COALESCE_MS);
  }, [message]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return (
    <div className={styles.live} role="status" aria-live="polite" aria-atomic="true">
      {spoken}
    </div>
  );
}
