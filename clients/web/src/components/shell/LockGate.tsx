"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isLockEnabled,
  markUnlocked,
  shouldLock,
  touchActivity,
  noteCredentialUnlock,
  unlockCredentialId,
  verifyPin,
} from "@/lib/lock/app-lock";

import styles from "@/app/login/login.module.css";
import { verifyWithCredential } from "@/lib/lock/webauthn";

/** Presents the lock screen over everything when the app is locked.
 *
 * Deliberately wraps the whole shell rather than individual screens: a lock
 * that leaves the chat list visible behind it is decoration. */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(false);
  const [checked, setChecked] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocked(shouldLock());
    setCredentialId(unlockCredentialId());
    setChecked(true);
  }, []);

  // Re-evaluate whenever the tab comes back, which is when an auto-lock
  // window has usually elapsed.
  useEffect(() => {
    const onVisible = () => {
      // Only on the way back. Touching activity on the way *out* restarted
      // the idle timer at exactly the moment it should have started counting,
      // so the window never elapsed while the tab was hidden.
      if (document.visibilityState === "visible") setLocked(shouldLock());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    if (locked || !isLockEnabled()) return;
    const onActivity = () => touchActivity();
    addEventListener("pointerdown", onActivity);
    addEventListener("keydown", onActivity);
    const timer = setInterval(() => setLocked(shouldLock()), 15_000);
    return () => {
      removeEventListener("pointerdown", onActivity);
      removeEventListener("keydown", onActivity);
      clearInterval(timer);
    };
  }, [locked]);

  useEffect(() => {
    if (locked) inputRef.current?.focus();
  }, [locked]);

  const unlock = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      const result = await verifyPin(pin);
      setBusy(false);
      setPin("");

      if (result.ok) {
        markUnlocked();
        setLocked(false);
        return;
      }
      if (result.lockedOutUntilMs) {
        const seconds = Math.ceil((result.lockedOutUntilMs - Date.now()) / 1000);
        setError(`Too many attempts. Try again in ${seconds}s.`);
        return;
      }
      setError(
        result.attemptsRemaining !== undefined
          ? `Wrong PIN. ${result.attemptsRemaining} attempts left.`
          : "Wrong PIN."
      );
    },
    [pin]
  );

  const unlockWithDevice = useCallback(async () => {
    if (!credentialId) return;
    setBusy(true);
    setError(null);
    const ok = await verifyWithCredential(credentialId);
    setBusy(false);
    if (!ok) {
      // Cancelling is the common case here, not an attack; the wording says
      // what to do rather than accusing anyone of anything.
      setError("Didn't unlock. Use your PIN instead, or try again.");
      return;
    }
    noteCredentialUnlock();
    markUnlocked();
    setLocked(false);
  }, [credentialId]);

  // Rendering children before the check would flash the chat list.
  if (!checked) return null;
  if (!locked) return <>{children}</>;

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden />
          <h1>Locked</h1>
        </div>

        <form onSubmit={unlock} className={styles.form}>
          <p className={styles.lede}>Enter your PIN to unlock Kuchupuchu.</p>
          <label className={styles.label} htmlFor="pin">
            PIN
          </label>
          <input
            id="pin"
            ref={inputRef}
            className={`${styles.input} ${styles.code}`}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
          <button className={styles.primary} type="submit" disabled={busy || pin.length === 0}>
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>

        {credentialId && (
          <button
            className={styles.link}
            type="button"
            disabled={busy}
            onClick={() => void unlockWithDevice()}
          >
            Use this device instead
          </button>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
