"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiError, requestOtp, verifyOtp } from "@/lib/api/client";
import { claimLocalDataFor } from "@/lib/auth/local-data";
import { useSession } from "@/lib/auth/SessionProvider";

import styles from "./login.module.css";

export default function LoginPage() {
  const router = useRouter();
  const { status, signIn } = useSession();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "authenticated") router.replace("/chats");
  }, [status, router]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestOtp(email.trim().toLowerCase());
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send the code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const normalized = email.trim().toLowerCase();
    try {
      // Before the code is spent, not after: verifyOtp registers this
      // browser's device id, and a member signing in after someone else needs
      // a fresh one rather than inheriting a device that is not theirs.
      await claimLocalDataFor(normalized);
      signIn(normalized, await verifyOtp(normalized, code.trim()));
      router.replace("/chats");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden />
          <h1>Kuchupuchu</h1>
        </div>

        {step === "email" ? (
          <form onSubmit={submitEmail} className={styles.form}>
            <p className={styles.lede}>Enter your email and we&apos;ll send you a code.</p>
            <label className={styles.label} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className={styles.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <button className={styles.primary} type="submit" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className={styles.form}>
            <p className={styles.lede}>
              We sent a 6-digit code to <strong>{email}</strong>.
            </p>
            <label className={styles.label} htmlFor="code">
              Code
            </label>
            <input
              id="code"
              ref={codeRef}
              className={`${styles.input} ${styles.code}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
            />
            <button className={styles.primary} type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Continue"}
            </button>
            <button
              className={styles.link}
              type="button"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </button>
          </form>
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
