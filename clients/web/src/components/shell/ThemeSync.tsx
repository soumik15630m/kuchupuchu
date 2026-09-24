"use client";

import { useEffect, useRef } from "react";

import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { THEME_SYNC_EVENT } from "@/lib/theme/storage";
import type { ThemeSettings } from "@/lib/theme/types";

/** Image wallpapers are per-device blobs in their own store; only the
 * reference would travel and it would resolve to nothing on the far side.
 * Everything else is small and portable. */
function portableTheme(theme: ThemeSettings) {
  return {
    ...theme,
    wallpapers: Object.fromEntries(
      Object.entries(theme.wallpapers).filter(([, wp]) => wp.kind !== "image")
    ),
  };
}

/** Mirrors display settings to this member's other devices.
 *
 * Lives here rather than in ThemeProvider because that provider wraps the
 * session and messaging ones — it cannot reach the client, and reordering the
 * tree would make the whole app wait on a WebSocket before it could pick a
 * colour. Renders nothing.
 */
export function ThemeSync() {
  const { theme } = useTheme();
  const { client } = useMessaging();
  // What was last sent or last received. Without it, applying an incoming
  // theme would immediately broadcast it back.
  const lastSynced = useRef<string | null>(null);

  // A theme that just arrived must not be broadcast straight back. Recorded
  // here, before the provider's own listener updates the state this watches.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const incoming = (e as CustomEvent<ThemeSettings>).detail;
      if (incoming) lastSynced.current = JSON.stringify(portableTheme(incoming));
    };
    addEventListener(THEME_SYNC_EVENT, onSynced);
    return () => removeEventListener(THEME_SYNC_EVENT, onSynced);
  }, []);

  useEffect(() => {
    if (!client) return;

    const portable = portableTheme(theme);
    const serialised = JSON.stringify(portable);
    if (lastSynced.current === null) {
      // First render after mount is the stored theme, not a change to it.
      lastSynced.current = serialised;
      return;
    }
    if (lastSynced.current === serialised) return;

    // Debounced: dragging an accent picker emits a change per frame.
    const handle = setTimeout(() => {
      lastSynced.current = serialised;
      void client.syncTheme(portable).catch(() => {
        // Another device will pick it up on their next change; a theme is
        // not worth a retry queue.
      });
    }, 1500);
    return () => clearTimeout(handle);
  }, [theme, client]);

  return null;
}
