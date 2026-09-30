"use client";

import { useEffect } from "react";

import { useSession } from "../auth/SessionProvider";
import { storedCredential } from "./credential";
import { shouldRunAutomatically } from "./drill.mjs";
import { loadDrillState, runDrill } from "./drill-service";

/** Runs the restore drill on its own, occasionally.
 *
 * The drill only means something if it happens without being asked for: a
 * backup nobody has opened in three months is a hope, and a member who has to
 * remember to press a button is a member who will not.
 *
 * Safe to run unattended because it writes nothing — it downloads, unseals,
 * inspects and discards. The rules about *when* live in drill.mjs: never
 * without a stored passphrase, never while offline, and at most once every
 * few days even on failure, so an unreachable server does not mean
 * re-downloading the archive on every app start.
 */
const START_DELAY_MS = 90_000;

export function useRestoreDrill(): void {
  const { session, email, status } = useSession();

  useEffect(() => {
    if (status !== "authenticated" || !session || !email) return;
    let cancelled = false;

    // Deliberately late. Opening the app should not spend the member's
    // bandwidth on a check before their messages have even loaded.
    const timer = setTimeout(async () => {
      if (cancelled) return;
      const credential = await storedCredential();
      const state = loadDrillState(Boolean(credential));
      if (!shouldRunAutomatically(state, Date.now(), { online: navigator.onLine })) return;
      if (cancelled) return;
      try {
        await runDrill(session, email);
      } catch {
        // runDrill records its own failure; nothing here should surface an
        // error for a check the member did not ask for.
      }
    }, START_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, email, status]);
}
