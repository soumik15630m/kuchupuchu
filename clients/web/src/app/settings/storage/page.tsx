"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import {
  cacheUsage,
  clearCache,
  pruneCache,
  requestPersistentStorage,
  type CacheUsage,
} from "@/lib/messaging/media-cache";

import settingsStyles from "../settings.module.css";
import themeStyles from "../theme/theme.module.css";

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function StoragePage() {
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [busy, setBusy] = useState<"clear" | "prune" | "persist" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    cacheUsage().then(setUsage);
    navigator.storage
      ?.estimate?.()
      .then((e) => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="Storage" backHref="/settings" />
        <PaneScroll>
          {note && <p style={{ color: "var(--ok)", padding: "10px 16px" }}>{note}</p>}

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Media on this device</h2>
            <p className={themeStyles.hint}>
              {usage === null
                ? "Measuring…"
                : `${usage.files} file${usage.files === 1 ? "" : "s"}, ${sizeLabel(usage.bytes)}.`}
              {quota
                ? ` This site is using ${sizeLabel(quota.usage)} of about ${sizeLabel(quota.quota)} available.`
                : ""}
            </p>
            <p className={themeStyles.hint}>
              Photos, video and voice notes are kept here after they are decrypted, so they do not
              have to be fetched again. The server deletes the originals after seven days —{" "}
              <strong>for anything older than that, this is the only copy</strong>, which is why
              clearing it cannot be undone without a backup.
            </p>
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Keep this data</h2>
            <p className={themeStyles.hint}>
              {usage?.persisted
                ? "Your browser has agreed not to evict this site's data under storage pressure."
                : "Your browser may delete this site's data if the device runs low on space."}
            </p>
            {!usage?.persisted && (
              <button
                className={themeStyles.reset}
                style={{ color: "var(--accent)" }}
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("persist");
                  try {
                    const granted = await requestPersistentStorage();
                    setNote(
                      granted
                        ? "Your browser agreed to keep this data."
                        : "Your browser declined. Installing the app usually changes its mind."
                    );
                    refresh();
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "persist" ? "Asking…" : "Ask the browser to keep it"}
              </button>
            )}
          </div>

          <div className={settingsStyles.divider} />

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Free up space</h2>
            <button
              className={themeStyles.reset}
              style={{ color: "var(--accent)" }}
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("prune");
                try {
                  const removed = await pruneCache();
                  setNote(
                    removed
                      ? `Removed ${removed} of the oldest cached file${removed === 1 ? "" : "s"}.`
                      : "Already within the cache limit — nothing removed."
                  );
                  refresh();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "prune" ? "Trimming…" : "Trim to the cache limit"}
            </button>
            <button
              className={themeStyles.reset}
              style={{ color: "var(--danger)" }}
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("clear");
                try {
                  await clearCache();
                  setNote("Cached media cleared.");
                  refresh();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "clear" ? "Clearing…" : "Clear all cached media"}
            </button>
            <p className={themeStyles.hint}>
              Messages are not affected. Media still within the server&apos;s seven-day window is
              fetched again on demand; anything older is gone unless it is in a backup.
            </p>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
