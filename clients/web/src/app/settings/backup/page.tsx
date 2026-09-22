"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { ApiError, type BackupMeta } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { createBackup, restoreBackup, type BackupProgress } from "@/lib/backup/service";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

import settingsStyles from "../settings.module.css";
import themeStyles from "../theme/theme.module.css";

const MIN_PASSPHRASE = 8;

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressLabel(p: BackupProgress): string {
  switch (p.stage) {
    case "collecting":
      return "Reading your chats…";
    case "media":
      return `Packing media ${p.done ?? 0} of ${p.total ?? 0}…`;
    case "encrypting":
      return "Encrypting…";
    case "uploading":
      return "Uploading…";
    case "downloading":
      return "Downloading…";
    case "decrypting":
      return "Decrypting…";
    case "writing":
      return p.total ? `Restoring ${p.done ?? 0} of ${p.total}…` : "Restoring…";
  }
}

export default function BackupPage() {
  const { session, email } = useSession();
  const { client, refreshChats } = useMessaging();

  const [meta, setMeta] = useState<({ exists: boolean } & Partial<BackupMeta>) | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [busy, setBusy] = useState<"backup" | "restore" | "delete" | null>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadMeta = useCallback(() => {
    if (!session) return;
    session
      .backupMeta()
      .then(setMeta)
      .catch(() => setMeta({ exists: false }));
  }, [session]);

  useEffect(loadMeta, [loadMeta]);

  async function runBackup() {
    if (!session || !email) return;
    setError(null);
    setNote(null);
    if (passphrase.length < MIN_PASSPHRASE) {
      setError(`Use at least ${MIN_PASSPHRASE} characters.`);
      return;
    }
    if (passphrase !== confirm) {
      setError("The two passphrases don't match.");
      return;
    }
    setBusy("backup");
    try {
      const { byteSize } = await createBackup(session, client, email, passphrase, setProgress);
      setNote(`Backed up ${sizeLabel(byteSize)}.`);
      setPassphrase("");
      setConfirm("");
      loadMeta();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That backup couldn't be completed.");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function runRestore() {
    if (!session || !restorePass) return;
    setError(null);
    setNote(null);
    setBusy("restore");
    try {
      const result = await restoreBackup(session, restorePass, setProgress);
      setNote(
        `Restored ${result.messages} message${result.messages === 1 ? "" : "s"}, ` +
          `${result.media} media file${result.media === 1 ? "" : "s"}` +
          (result.skipped ? ` — ${result.skipped} already here.` : ".")
      );
      setRestorePass("");
      refreshChats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That backup couldn't be restored.");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function runDelete() {
    if (!session) return;
    setBusy("delete");
    setError(null);
    setNote(null);
    try {
      await session.deleteBackup();
      setNote("Backup deleted from the server.");
      loadMeta();
    } catch {
      setError("That backup couldn't be deleted.");
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null;

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="Chat backup" backHref="/settings" />
        <PaneScroll>
          {error && <p style={{ color: "var(--danger)", padding: "10px 16px" }}>{error}</p>}
          {note && <p style={{ color: "var(--ok)", padding: "10px 16px" }}>{note}</p>}
          {progress && (
            <p style={{ color: "var(--ink-muted)", padding: "0 16px" }}>{progressLabel(progress)}</p>
          )}

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Current backup</h2>
            <p className={themeStyles.hint}>
              {meta === null
                ? "Checking…"
                : meta.exists
                  ? `${sizeLabel(meta.byteSize ?? 0)}, made ${new Date(
                      meta.createdAt ?? Date.now()
                    ).toLocaleString()}.`
                  : "You don't have a backup yet."}
            </p>
            {meta?.exists && (
              <button
                className={themeStyles.reset}
                style={{ color: "var(--danger)" }}
                type="button"
                onClick={runDelete}
                disabled={working}
              >
                {busy === "delete" ? "Deleting…" : "Delete backup from server"}
              </button>
            )}
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Back up now</h2>
            <div className={themeStyles.customRow} style={{ marginTop: 0 }}>
              <input
                className={themeStyles.hexInput}
                style={{ width: "100%", fontFamily: "inherit", textTransform: "none" }}
                type="password"
                placeholder="Backup passphrase"
                aria-label="Backup passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>
            <div className={themeStyles.customRow} style={{ marginTop: 8 }}>
              <input
                className={themeStyles.hexInput}
                style={{ width: "100%", fontFamily: "inherit", textTransform: "none" }}
                type="password"
                placeholder="Confirm passphrase"
                aria-label="Confirm passphrase"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <button
              className={themeStyles.reset}
              style={{ color: "var(--accent)" }}
              type="button"
              onClick={runBackup}
              disabled={working}
            >
              {busy === "backup" ? "Backing up…" : "Back up messages and media"}
            </button>
            <p className={themeStyles.hint}>
              Your chats and media are encrypted on this device before they are uploaded. The
              server stores the result and can tell you how big it is, but cannot read any of it.
            </p>
            <p className={themeStyles.hint}>
              <strong>There is no way to recover this passphrase.</strong> It is never sent
              anywhere, so if you forget it the backup is permanently unreadable — by us, by you,
              by anyone. Write it down somewhere safe.
            </p>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Restore</h2>
            <div className={themeStyles.customRow} style={{ marginTop: 0 }}>
              <input
                className={themeStyles.hexInput}
                style={{ width: "100%", fontFamily: "inherit", textTransform: "none" }}
                type="password"
                placeholder="Backup passphrase"
                aria-label="Passphrase to restore with"
                value={restorePass}
                onChange={(e) => setRestorePass(e.target.value)}
              />
            </div>
            <button
              className={themeStyles.reset}
              style={{ color: "var(--accent)" }}
              type="button"
              onClick={runRestore}
              disabled={working || !meta?.exists || !restorePass}
            >
              {busy === "restore" ? "Restoring…" : "Restore from backup"}
            </button>
            <p className={themeStyles.hint}>
              Restoring adds anything missing. Messages already on this device are left alone, so
              their read state and stars are not rolled back.
            </p>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
