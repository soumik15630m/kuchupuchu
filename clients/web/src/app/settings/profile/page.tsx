"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { ApiError } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { useDirectory } from "@/lib/directory/DirectoryProvider";
import { squareCrop } from "@/lib/messaging/media";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

import settingsStyles from "../settings.module.css";
import themeStyles from "../theme/theme.module.css";

export default function ProfilePage() {
  const { session, email } = useSession();
  const { me, others, refresh } = useDirectory();
  const { client } = useMessaging();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [about, setAbout] = useState("");
  const [busy, setBusy] = useState<"username" | "profile" | "photo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setUsername(me.username ?? "");
    setDisplayName(me.displayName ?? "");
    setAbout(me.about ?? "");
  }, [me]);

  async function saveUsername() {
    if (!session || !username.trim()) return;
    setBusy("username");
    setError(null);
    setSaved(null);
    try {
      await session.setUsername(username.trim());
      await refresh();
      setSaved("Username saved.");
    } catch (err) {
      // The server's message is written for the user ("that username is
      // taken", "cannot start or end with a dot") so it is shown verbatim.
      setError(err instanceof ApiError ? err.message : "Couldn't save that username.");
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile() {
    if (!session) return;
    setBusy("profile");
    setError(null);
    setSaved(null);
    try {
      await session.setProfile({ displayName: displayName.trim(), about: about.trim() });
      await refresh();
      setSaved("Profile saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save your profile.");
    } finally {
      setBusy(null);
    }
  }

  async function setPhoto(blob: Blob | null) {
    if (!client) return;
    setBusy("photo");
    setError(null);
    setSaved(null);
    try {
      await client.setAvatar(
        others.map((m) => m.email),
        blob ? await squareCrop(blob) : null
      );
      setSaved(blob ? "Photo updated." : "Photo removed.");
    } catch {
      setError("Couldn't update your photo.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const label = displayName || username || email || "";

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="Profile" backHref="/settings" />
        <PaneScroll>
          <div className={settingsStyles.profile}>
            <Avatar
              email={email ?? ""}
              label={label}
              size={56}
              className={settingsStyles.avatar}
            />
            <div className={settingsStyles.who}>
              <div className={settingsStyles.name}>{label}</div>
              <div className={settingsStyles.email}>{email}</div>
              <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                <button
                  type="button"
                  className={themeStyles.reset}
                  style={{ color: "var(--accent)", padding: 0 }}
                  onClick={() => fileRef.current?.click()}
                  disabled={busy !== null || !client}
                >
                  {busy === "photo" ? "Working…" : "Change photo"}
                </button>
                <button
                  type="button"
                  className={themeStyles.reset}
                  style={{ color: "var(--danger)", padding: 0 }}
                  onClick={() => setPhoto(null)}
                  disabled={busy !== null || !client}
                >
                  Remove
                </button>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setPhoto(file);
              }}
            />
          </div>
          <p className={themeStyles.hint} style={{ padding: "0 16px" }}>
            Your photo is encrypted and sent to each member individually — the server only ever
            stores ciphertext, and never holds the key to it.
          </p>

          {error && <p style={{ color: "var(--danger)", padding: "0 16px" }}>{error}</p>}
          {saved && <p style={{ color: "var(--ok)", padding: "0 16px" }}>{saved}</p>}

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Username</h2>
            <div className={themeStyles.customRow} style={{ marginTop: 0 }}>
              <span style={{ color: "var(--ink-muted)", fontSize: 18 }}>@</span>
              <input
                className={themeStyles.hexInput}
                style={{ fontFamily: "inherit" }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                aria-label="Username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <button
              className={themeStyles.reset}
              style={{ color: "var(--accent)" }}
              type="button"
              onClick={saveUsername}
              disabled={busy !== null || !username.trim() || username.trim() === (me?.username ?? "")}
            >
              {busy === "username" ? "Saving…" : "Save username"}
            </button>
            <p className={themeStyles.hint}>
              3–30 characters: letters, digits, dots and underscores. This is how other members find
              you. Changing it parks the old one for 30 days so nobody can pick it up and be mistaken
              for you.
            </p>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Display name</h2>
            <input
              className={themeStyles.hexInput}
              style={{ width: "100%", fontFamily: "inherit", textTransform: "none" }}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              aria-label="Display name"
              maxLength={64}
            />

            <h2 className={themeStyles.sectionTitle} style={{ marginTop: 18 }}>
              About
            </h2>
            <input
              className={themeStyles.hexInput}
              style={{ width: "100%", fontFamily: "inherit", textTransform: "none" }}
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Anything you like"
              aria-label="About"
              maxLength={200}
            />

            <button
              className={themeStyles.reset}
              style={{ color: "var(--accent)" }}
              type="button"
              onClick={saveProfile}
              disabled={busy !== null}
            >
              {busy === "profile" ? "Saving…" : "Save profile"}
            </button>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
