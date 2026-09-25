"use client";

import { useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import {
  AUTO_LOCK_OPTIONS,
  disableLock,
  enableLock,
  isLockEnabled,
  loadLock,
  markUnlocked,
  setAutoLock,
} from "@/lib/lock/app-lock";
import { linkPreviewsEnabled, setLinkPreviewsEnabled } from "@/lib/messaging/link-preview";
import { defaultSharing, loadSharing, saveSharing } from "@/lib/messaging/privacy.mjs";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

import settingsStyles from "../settings.module.css";
import themeStyles from "../theme/theme.module.css";

const MIN_PIN = 4;

export default function PrivacyPage() {
  const { client } = useMessaging();
  const [enabled, setEnabled] = useState(false);
  const [autoLockMs, setAutoLockMsState] = useState<number>(60_000);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState(true);
  const [sharing, setSharing] = useState(defaultSharing);

  useEffect(() => {
    setEnabled(isLockEnabled());
    const config = loadLock();
    if (config) setAutoLockMsState(config.autoLockMs);
    setPreviews(linkPreviewsEnabled());
    setSharing(loadSharing());
  }, []);

  async function turnOn() {
    setError(null);
    setSaved(null);
    if (pin.length < MIN_PIN) {
      setError(`Use at least ${MIN_PIN} digits.`);
      return;
    }
    if (pin !== confirm) {
      setError("The two PINs don't match.");
      return;
    }
    setBusy(true);
    try {
      await enableLock(pin, autoLockMs);
      // Unlocked straight away: locking someone out of the screen they just
      // configured would be absurd.
      markUnlocked();
      setEnabled(true);
      setPin("");
      setConfirm("");
      setSaved("App lock is on.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="Privacy" backHref="/settings" />
        <PaneScroll>
          {error && <p style={{ color: "var(--danger)", padding: "10px 16px" }}>{error}</p>}
          {saved && <p style={{ color: "var(--ok)", padding: "10px 16px" }}>{saved}</p>}

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>App lock</h2>

            {enabled ? (
              <>
                <p className={themeStyles.hint}>
                  Kuchupuchu asks for your PIN before showing your chats.
                </p>
                <h2 className={themeStyles.sectionTitle} style={{ marginTop: 16 }}>
                  Lock
                </h2>
                <div className={themeStyles.options} role="radiogroup" aria-label="Auto lock">
                  {AUTO_LOCK_OPTIONS.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      aria-checked={autoLockMs === option.ms}
                      className={themeStyles.radio}
                      onClick={() => {
                        setAutoLockMsState(option.ms);
                        setAutoLock(option.ms);
                        setSaved("Saved.");
                      }}
                    >
                      <span className={themeStyles.radioMark} />
                      <span className={themeStyles.radioLabel}>{option.label}</span>
                    </button>
                  ))}
                </div>

                <button
                  className={themeStyles.reset}
                  type="button"
                  onClick={() => {
                    disableLock();
                    setEnabled(false);
                    setSaved("App lock is off.");
                  }}
                >
                  Turn off app lock
                </button>
              </>
            ) : (
              <>
                <p className={themeStyles.hint}>
                  Ask for a PIN before showing your chats.
                </p>
                <div className={themeStyles.customRow} style={{ marginTop: 10 }}>
                  <input
                    className={themeStyles.hexInput}
                    type="password"
                    inputMode="numeric"
                    placeholder="New PIN"
                    aria-label="New PIN"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                  />
                </div>
                <div className={themeStyles.customRow} style={{ marginTop: 8 }}>
                  <input
                    className={themeStyles.hexInput}
                    type="password"
                    inputMode="numeric"
                    placeholder="Confirm PIN"
                    aria-label="Confirm PIN"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                <button
                  className={themeStyles.reset}
                  style={{ color: "var(--accent)" }}
                  type="button"
                  onClick={turnOn}
                  disabled={busy}
                >
                  {busy ? "Saving…" : "Turn on app lock"}
                </button>
              </>
            )}

            <p className={themeStyles.hint} style={{ marginTop: 16 }}>
              This hides the app behind a PIN. It does <strong>not</strong> encrypt your messages on
              this device — anyone with real access to this computer&apos;s profile can still read
              the stored data. Use your operating system&apos;s disk encryption for that.
            </p>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>What others see</h2>
            {(
              [
                {
                  key: "readReceipts" as const,
                  label: "Read receipts",
                  hint: "Turning these off also hides other people's from you. Receipts in groups are always sent.",
                },
                {
                  key: "typing" as const,
                  label: "Typing indicator",
                  hint: "Turning this off also hides when other people are typing.",
                },
                {
                  key: "lastSeen" as const,
                  label: "Online and last seen",
                  hint: "Turning this off also hides everyone else's. The server keeps last-seen times in memory only — they are never written to disk, and a restart forgets them.",
                },
              ]
            ).map((row) => (
              <div key={row.key} style={{ marginBottom: 14 }}>
                <h2 className={themeStyles.sectionTitle} style={{ marginTop: 10 }}>
                  {row.label}
                </h2>
                <div className={themeStyles.options} role="radiogroup" aria-label={row.label}>
                  {[
                    { label: "On", value: true },
                    { label: "Off", value: false },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      aria-checked={sharing[row.key] === option.value}
                      className={themeStyles.radio}
                      onClick={() => {
                        setSharing(saveSharing({ [row.key]: option.value }));
                        // Presence is relayed by the server, so the change has
                        // to reach it now rather than on the next connect.
                        if (row.key === "lastSeen") client?.publishPresenceSharing();
                        setSaved("Saved.");
                      }}
                    >
                      <span className={themeStyles.radioMark} />
                      <span className={themeStyles.radioLabel}>{option.label}</span>
                    </button>
                  ))}
                </div>
                <p className={themeStyles.hint}>{row.hint}</p>
              </div>
            ))}
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Link previews</h2>
            <div className={themeStyles.options} role="radiogroup" aria-label="Link previews">
              {[
                { label: "On", value: true },
                { label: "Off", value: false },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={previews === option.value}
                  className={themeStyles.radio}
                  onClick={() => {
                    setPreviews(option.value);
                    setLinkPreviewsEnabled(option.value);
                    setSaved("Saved.");
                  }}
                >
                  <span className={themeStyles.radioMark} />
                  <span className={themeStyles.radioLabel}>{option.label}</span>
                </button>
              ))}
            </div>
            <p className={themeStyles.hint}>
              To show a preview of a link you paste, your own server has to fetch that page — so it
              learns the address, though nobody outside it does. Turning this off means no link you
              type ever leaves this device. Previews you <em>receive</em> are unaffected: they
              arrive inside the encrypted message and never contact the site.
            </p>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Sign-in</h2>
            <p className={themeStyles.hint}>
              Every sign-in already needs a fresh code sent to your email, and each device is
              registered separately and can be revoked from Linked devices. There is no password to
              add a second factor to.
            </p>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
