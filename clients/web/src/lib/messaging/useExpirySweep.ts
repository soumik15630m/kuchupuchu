"use client";

import { useEffect } from "react";

import { nextSweepDelayMs } from "./ephemeral.mjs";
import { deleteCachedMedia } from "./media-cache";
import { allMessages, deleteExpired } from "./store";

/** Deletes messages whose disappearing-messages timer has run out.
 *
 * Runs on mount and then sleeps until the next expiry rather than polling on
 * a fixed interval: most chats have no timer at all, and a one-minute tick
 * across every message in the store is a lot of work to discover that
 * repeatedly.
 *
 * Also runs when the tab becomes visible again. A laptop that slept through
 * an expiry would otherwise show the message until its timer happened to
 * fire, which is the one moment the member is actually looking.
 */
export function useExpirySweep(onSwept: (chatIds: string[]) => void): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    async function sweep() {
      if (stopped) return;
      const gone = await deleteExpired();
      if (gone.length > 0) {
        // The bytes too. A photo whose message is gone but whose blob is
        // still cached has not disappeared in any sense that matters.
        await Promise.all(
          gone.filter((m) => m.media).map((m) => deleteCachedMedia(m.media!.mediaId))
        );
        onSwept([...new Set(gone.map((m) => m.chatId))]);
      }
      if (stopped) return;
      const delay = nextSweepDelayMs(await allMessages(), Date.now());
      if (delay !== null) timer = setTimeout(() => void sweep(), delay);
    }

    void sweep();

    const onVisible = () => {
      if (document.visibilityState === "visible") void sweep();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [onSwept]);
}
