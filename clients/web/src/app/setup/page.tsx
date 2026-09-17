"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiError } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { useDirectory } from "@/lib/directory/DirectoryProvider";

import styles from "@/app/login/login.module.css";

/** One-time step after a first sign-in: pick the handle other members will use.
 * Gated by AppShell, so there is no way into the app without it. */
export default function SetupPage() {
  const router = useRouter();
  const { status, session } = useSession();
  const { me, loading, refresh } = useDirectory();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  useEffect(() => {
    if (!loading && me?.username) router.replace("/chats");
  }, [loading, me, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await session.setUsername(username.trim());
      if (displayName.trim()) await session.setProfile({ displayName: displayName.trim() });
      await refresh();
      router.replace("/chats");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Try another username.");
    } finally {
      setBusy(false);
    }
  }

  if (status !== "authenticated") return null;

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden />
          <h1>Pick a username</h1>
        </div>

        <form onSubmit={submit} className={styles.form}>
          <p className={styles.lede}>
            This is how the others find you. You can change it later.
          </p>

          <label className={styles.label} htmlFor="username">
            Username
          </label>
          <input
            id="username"
            className={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            autoCapitalize="none"
            autoComplete="username"
            spellCheck={false}
            required
          />

          <label className={styles.label} htmlFor="displayName">
            Display name <span style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id="displayName"
            className={styles.input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            maxLength={64}
          />

          <button className={styles.primary} type="submit" disabled={busy || !username.trim()}>
            {busy ? "Saving…" : "Continue"}
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
