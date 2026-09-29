"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { ApiError, type BackupMeta } from "@/lib/api/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { forgetPassphrase, rememberPassphrase, storedCredential } from "@/lib/backup/credential";
import { nextRunAtMs, type BackupFrequency, type BackupSettings } from "@/lib/backup/schedule.mjs";
import { createBackup, restoreBackup, type BackupProgress } from "@/lib/backup/service";
import { loadBackupSettings, saveBackupSettings } from "@/lib/backup/settings";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

import settingsStyles from "../settings.module.css";
import themeStyles from "../theme/theme.module.css";
import { loadDrillState, runDrill, type DrillState } from "@/lib/backup/drill-service";
import { describeResult, isStale } from "@/lib/backup/drill.mjs";

const MIN_PASSPHRASE = 8;

const FREQUENCY_OPTIONS: { label: string; value: BackupFrequency }[] = [
  { label: "Off", value: "off" },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
];

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
  const [settings, setSettings] = useState<BackupSettings>(() => loadBackupSettings());
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [busy, setBusy] = useState<"save" | "backup" | "restore" | "delete" | "forget" | null>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillState>(() => loadDrillState(false));
  const [drillRunning, setDrillRunning] = useState(false);

  const loadMeta = useCallback(() => {
    if (!session) return;
    session
      .backupMeta()
      .then(setMeta)
      .catch(() => setMeta({ exists: false }));
  }, [session]);

  useEffect(loadMeta, [loadMeta]);

  useEffect(() => {
    storedCredential().then((c) => {
      setHasKey(Boolean(c));
      // Reloaded once the answer is known: whether a passphrase is stored is
      // what decides if the drill can run on its own.
      setDrill(loadDrillState(Boolean(c)));
    });
  }, []);

  function patchSettings(next: Partial<BackupSettings>) {
    setSettings(saveBackupSettings(next));
  }

  async function savePassphrase() {
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
    setBusy("save");
    try {
      await rememberPassphrase(passphrase);
      setHasKey(true);
      setPassphrase("");
      setConfirm("");
      // A new passphrase means a new key, so whatever is on the server can no
      // longer be opened with it. Clearing the success time makes the next
      // scheduled run fire immediately rather than in a day's time.
      patchSettings({ lastSuccessMs: null, lastError: null });
      setNote("Passphrase saved on this device.");
    } catch {
      setError("That passphrase couldn't be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function runBackup() {
    if (!session || !email) return;
    setError(null);
    setNote(null);
    const credential = await storedCredential();
    if (!credential) {
      setError("Set a backup passphrase first.");
      return;
    }
    setBusy("backup");
    try {
      const { byteSize, skipped } = await createBackup(
        session,
        client,
        email,
        credential,
        { includeMedia: settings.includeMedia },
        setProgress
      );
      patchSettings({ lastSuccessMs: Date.now(), lastAttemptMs: Date.now(), lastError: null });
      setNote(
        skipped
          ? `Nothing has changed since the last backup — ${sizeLabel(byteSize)} left as it is.`
          : `Backed up ${sizeLabel(byteSize)}.`
      );
      loadMeta();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "That backup couldn't be completed.";
      patchSettings({ lastAttemptMs: Date.now(), lastError: message });
      setError(message);
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
        `Restored ${result.messages} message${result.messages === 1 ? "" : "s"}` +
          (result.includedMedia
            ? `, ${result.media} media file${result.media === 1 ? "" : "s"}`
            : " (this backup had no media)") +
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

  async function stopAutomatic() {
    setBusy("forget");
    setError(null);
    setNote(null);
    try {
      await forgetPassphrase();
      setHasKey(false);
      patchSettings({ frequency: "off", lastError: null });
      setNote("Automatic backup stopped and the passphrase removed from this device.");
    } finally {
      setBusy(null);
    }
  }

  async function runDelete() {
    if (!session) return;
    setBusy("delete");
    setError(null);
    setNote(null);
    try {
      await session.deleteBackup();
      patchSettings({ lastSuccessMs: null });
      setNote("Backup deleted from the server.");
      loadMeta();
    } catch {
      setError("That backup couldn't be deleted.");
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null;
  const nextRun = nextRunAtMs(settings, Date.now());

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
            {settings.lastError && (
              <p className={themeStyles.hint} style={{ color: "var(--danger)" }}>
                Last attempt failed: {settings.lastError}
              </p>
            )}
            <button
              className={themeStyles.reset}
              style={{ color: "var(--accent)" }}
              type="button"
              onClick={runBackup}
              disabled={working || !hasKey}
            >
              {busy === "backup" ? "Backing up…" : "Back up now"}
            </button>
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
            <h2 className={themeStyles.sectionTitle}>Automatic backup</h2>
            {hasKey === false ? (
              <p className={themeStyles.hint}>
                Set a passphrase below to turn on automatic backups.
              </p>
            ) : (
              <>
                <div className={themeStyles.options} role="radiogroup" aria-label="Backup frequency">
                  {FREQUENCY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={settings.frequency === option.value}
                      className={themeStyles.radio}
                      disabled={working}
                      onClick={() => {
                        patchSettings({ frequency: option.value, lastError: null });
                        setNote(
                          option.value === "off"
                            ? "Automatic backup is off."
                            : `Backing up ${option.value}.`
                        );
                      }}
                    >
                      <span className={themeStyles.radioMark} />
                      <span className={themeStyles.radioLabel}>{option.label}</span>
                    </button>
                  ))}
                </div>

                <p className={themeStyles.hint}>
                  {settings.frequency === "off"
                    ? "Backups only happen when you press Back up now."
                    : nextRun && nextRun > Date.now()
                      ? `Next backup around ${new Date(nextRun).toLocaleString()}.`
                      : "Next backup will run shortly."}
                  {settings.lastSuccessMs
                    ? ` Last succeeded ${new Date(settings.lastSuccessMs).toLocaleString()}.`
                    : ""}
                </p>

                <h2 className={themeStyles.sectionTitle} style={{ marginTop: 18 }}>
                  What to include
                </h2>
                <div className={themeStyles.options} role="radiogroup" aria-label="What to include">
                  {[
                    { label: "Messages and media", value: true },
                    { label: "Messages only", value: false },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      aria-checked={settings.includeMedia === option.value}
                      className={themeStyles.radio}
                      disabled={working}
                      onClick={() => {
                        patchSettings({ includeMedia: option.value });
                        setNote("Saved.");
                      }}
                    >
                      <span className={themeStyles.radioMark} />
                      <span className={themeStyles.radioLabel}>{option.label}</span>
                    </button>
                  ))}
                </div>
                <p className={themeStyles.hint}>
                  Photos, video and voice notes are much larger than the text around them. Leaving
                  them out keeps backups small and quick, but a restore on a new device will show
                  media as unavailable — the server deletes the originals after seven days.
                </p>

                <button
                  className={themeStyles.reset}
                  style={{ color: "var(--danger)" }}
                  type="button"
                  onClick={stopAutomatic}
                  disabled={working}
                >
                  {busy === "forget"
                    ? "Stopping…"
                    : "Stop automatic backup and forget the passphrase"}
                </button>
              </>
            )}
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>
              {hasKey ? "Change passphrase" : "Backup passphrase"}
            </h2>
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
              onClick={savePassphrase}
              disabled={working}
            >
              {busy === "save" ? "Saving…" : hasKey ? "Change passphrase" : "Save passphrase"}
            </button>
            <p className={themeStyles.hint}>
              The key is derived here and kept on this device so scheduled backups can run without
              asking again. The passphrase itself is never stored and never uploaded — the server
              holds ciphertext it cannot read.
            </p>
            <p className={themeStyles.hint}>
              <strong>There is no way to recover this passphrase.</strong> If you forget it the
              backup is permanently unreadable — by us, by you, by anyone. Write it down somewhere
              safe.
              {hasKey ? " Changing it means the next backup replaces the one on the server." : ""}
            </p>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Can it actually be restored?</h2>
            <p className={themeStyles.hint} role="status">
              {drillRunning
                ? "Checking — downloading and opening the backup…"
                : describeResult(drill.last, Date.now(), (ms) => new Date(ms).toLocaleDateString())}
            </p>

            {drill.last && !drill.last.ok && drill.last.problems.length > 1 && (
              <ul className={themeStyles.hint} style={{ paddingLeft: 18 }}>
                {drill.last.problems.slice(1).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}

            {drill.last?.ok && drill.last.kdfIterations && (
              <p className={themeStyles.hint}>
                Sealed with {drill.last.kdfIterations.toLocaleString()} rounds of key
                strengthening, and opened without touching anything on this device.
              </p>
            )}

            <button
              className={themeStyles.reset}
              type="button"
              disabled={drillRunning || busy !== null}
              onClick={async () => {
                if (!session || !email) return;
                setDrillRunning(true);
                try {
                  await runDrill(session, email, restorePass.trim() || undefined);
                } finally {
                  setDrill(loadDrillState(hasKey === true));
                  setDrillRunning(false);
                }
              }}
            >
              {drillRunning ? "Checking…" : "Check the backup now"}
            </button>

            <p className={themeStyles.hint}>
              Downloads the backup, opens it, and reads what is inside — then throws it away.
              Nothing on this device is changed, which is why it is safe to run whenever. A backup
              nobody has ever opened is a hope, not a backup.
              {isStale(drill.lastVerifiedAtMs, Date.now()) && drill.lastVerifiedAtMs
                ? " This one has not been checked in over a week."
                : ""}
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
