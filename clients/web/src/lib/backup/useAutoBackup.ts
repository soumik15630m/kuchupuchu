"use client";

import { useEffect, useRef } from "react";

import { useSession } from "../auth/SessionProvider";
import { useMessaging } from "../messaging/MessagingProvider";

import { storedCredential } from "./credential";
import { isDue } from "./schedule.mjs";
import { createBackup } from "./service";
import { loadBackupSettings, saveBackupSettings } from "./settings";

/** How often to look at the clock. The schedule itself is measured in days,
 * so this only has to be often enough that a machine left open for a week
 * notices; five minutes is already far more than needed. */
const POLL_MS = 5 * 60 * 1000;

/** Runs the scheduled backup when it comes due.
 *
 * Mounted once, near the root. Everything that decides *whether* to run is in
 * schedule.mjs; this only supplies the clock and the side effects.
 *
 * `runningSinceMs` is written to storage before the work starts, so a second
 * tab polling at the same moment sees a run in flight and stands down. It is
 * a lock in shared storage rather than in memory for exactly that reason --
 * two tabs each re-uploading the whole archive would be the obvious failure.
 */
export function useAutoBackup(): void {
  const { session, email, status } = useSession();
  const { client } = useMessaging();
  // Held in a ref so a reconnecting messaging client does not restart the
  // poll timer and re-check immediately on every reconnect.
  const clientRef = useRef(client);
  clientRef.current = client;
  const inFlight = useRef(false);

  useEffect(() => {
    if (status !== "authenticated" || !session || !email) return;

    let stopped = false;

    const tick = async () => {
      if (stopped || inFlight.current) return;
      const settings = loadBackupSettings();
      if (!isDue(settings, Date.now())) return;

      const credential = await storedCredential();
      if (!credential) {
        // The schedule is on but the key is gone -- the passphrase was
        // forgotten on this device. Turning the schedule off is the honest
        // outcome; leaving it on would fail silently forever.
        saveBackupSettings({
          frequency: "off",
          lastError: "the backup passphrase is no longer stored on this device",
        });
        return;
      }

      inFlight.current = true;
      saveBackupSettings({ runningSinceMs: Date.now(), lastAttemptMs: Date.now() });
      try {
        await createBackup(session, clientRef.current, email, credential, {
          includeMedia: settings.includeMedia,
        });
        saveBackupSettings({
          lastSuccessMs: Date.now(),
          lastError: null,
          runningSinceMs: null,
        });
      } catch (err) {
        saveBackupSettings({
          lastError: err instanceof Error ? err.message : "the backup could not be completed",
          runningSinceMs: null,
        });
      } finally {
        inFlight.current = false;
      }
    };

    // Not on the very first paint: a backup competing with the initial
    // message sync makes opening the app feel broken.
    const initial = setTimeout(tick, 30_000);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [status, session, email]);
}
