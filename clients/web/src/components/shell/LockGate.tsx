"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isLockEnabled,
  markUnlocked,
  shouldLock,
  touchActivity,
  verifyPin,
} from "@/lib/lock/app-lock";

import styles from "@/app/login/login.module.css";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocked(shouldLock());
    setChecked(true);
  }, []);

  // Re-evaluate whenever the tab comes back, which is when an auto-lock
  // window has usually elapsed.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setLocked(shouldLock());
      else touchActivity();
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

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
