"use client";

import { useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { StatusViewer } from "@/components/status/StatusViewer";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { useSession } from "@/lib/auth/SessionProvider";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import {
  defaultStatusAudience,
  describeStatusAudience,
  loadStatusAudience,
  saveStatusAudience,
  statusRecipients,
} from "@/lib/messaging/status-audience.mjs";
import { compressImage, makeThumbnail, videoPoster } from "@/lib/messaging/media";
import type { StatusReel } from "@/lib/messaging/status-store";

import styles from "./status.module.css";

const BACKGROUNDS = ["#00a884", "#5b6ef5", "#8b5cf6", "#f43f5e", "#f59e0b", "#0ea5e9", "#334155"];

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

export default function StatusPage() {
  const { email } = useSession();
  const { client, statuses, refreshStatuses } = useMessaging();
  const { others, nameFor } = useDirectory();
  const [open, setOpen] = useState<StatusReel | null>(null);
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [background, setBackground] = useState(BACKGROUNDS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [statusAudience, setStatusAudience] = useState(defaultStatusAudience);
  const [pickingAudience, setPickingAudience] = useState(false);

  useEffect(() => {
    setStatusAudience(loadStatusAudience());
  }, []);

  /** Who this post is encrypted for.
   *
   * Exclusion is real rather than a flag: someone left out never receives the
   * ciphertext, so there is no server-side visibility rule that could be got
   * wrong or changed later. */
  function audience(): string[] {
    return statusRecipients(statusAudience, others.map((m) => m.email));
  }

  const mine = statuses.filter((r) => r.outgoing);
  const theirs = statuses.filter((r) => !r.outgoing);

  async function postText() {
    if (!client || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.postStatus(audience(), { body: text.trim(), background });
      setText("");
      setComposing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post that.");
    } finally {
      setBusy(false);
      refreshStatuses();
    }
  }

  async function postMedia(file: File) {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const isVideo = file.type.startsWith("video/");
      let blob: Blob = file;
      let thumb: string | undefined;
      let durationMs: number | undefined;
      let width: number | undefined;
      let height: number | undefined;

      if (file.type.startsWith("image/")) {
        const compressed = await compressImage(file);
        blob = compressed.blob;
        width = compressed.width;
        height = compressed.height;
        thumb = await makeThumbnail(blob);
      } else if (isVideo) {
        const poster = await videoPoster(file);
        thumb = poster.thumb;
        durationMs = poster.durationMs;
      }

      const to = audience();
      const { mediaId, key, iv } = await client.uploadMedia(to, blob);
      await client.postStatus(to, {
        body: text.trim(),
        media: {
          mediaId,
          key,
          iv,
          mime: blob.type || file.type || "application/octet-stream",
          name: file.name,
          byteSize: blob.size,
          width,
          height,
          thumb,
          durationMs,
        },
      });
      setText("");
      setComposing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post that.");
    } finally {
      setBusy(false);
      refreshStatuses();
    }
  }

  function Row({ reel }: { reel: StatusReel }) {
    const latest = reel.posts[reel.posts.length - 1];
    const name = reel.outgoing ? "My status" : nameFor(reel.authorEmail);
    return (
      <button type="button" className={styles.row} onClick={() => setOpen(reel)}>
        <span className={styles.ring} data-unseen={reel.unseen > 0 ? "true" : undefined}>
          <span className={styles.ringInner}>
            {latest?.media?.thumb ? <img src={latest.media.thumb} alt="" /> : initialsFor(name)}
          </span>
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowName}>{name}</span>
          <span className={styles.rowMeta}>
            {reel.posts.length} update{reel.posts.length === 1 ? "" : "s"} · {ago(latest.postedAtMs)}
          </span>
        </span>
      </button>
    );
  }

  return (
    <AppShell detail={<PaneEmpty>Status updates disappear after 24 hours.</PaneEmpty>}>
      <Pane>
        <PaneHeader title="Status" />
        <PaneScroll>
          {error && <p style={{ color: "var(--danger)", padding: "10px 14px" }}>{error}</p>}

          <button
            type="button"
            className={styles.audienceRow}
            onClick={() => setPickingAudience((v) => !v)}
          >
            <span>Who can see your status</span>
            <strong>{describeStatusAudience(statusAudience, others.map((m) => m.email))}</strong>
          </button>

          {pickingAudience && (
            <div className={styles.audiencePicker}>
              <div className={styles.audienceModes}>
                {(
                  [
                    ["all", "Everyone except…"],
                    ["only", "Only share with…"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    data-active={statusAudience.mode === mode}
                    onClick={() => setStatusAudience(saveStatusAudience({ mode }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {others.map((member) => {
                const list =
                  statusAudience.mode === "only" ? statusAudience.only : statusAudience.except;
                const checked = list.includes(member.email.toLowerCase());
                return (
                  <label key={member.email} className={styles.audienceMember}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const email = member.email.toLowerCase();
                        const next = checked
                          ? list.filter((e) => e !== email)
                          : [...list, email];
                        setStatusAudience(
                          saveStatusAudience(
                            statusAudience.mode === "only" ? { only: next } : { except: next }
                          )
                        );
                      }}
                    />
                    <span>{nameFor(member.email)}</span>
                  </label>
                );
              })}
              <p className={styles.audienceHint}>
                Anyone left out never receives the post at all — it is not encrypted for them, so
                there is nothing on the server for them to be shown by mistake.
              </p>
            </div>
          )}

          {composing ? (
            <div className={styles.composeSheet}>
              <textarea
                className={styles.textArea}
                style={{ background, color: "#fff" }}
                value={text}
                placeholder="Type a status"
                aria-label="Status text"
                onChange={(e) => setText(e.target.value)}
              />
              <div className={styles.backgrounds} role="radiogroup" aria-label="Background colour">
                {BACKGROUNDS.map((colour) => (
                  <button
                    key={colour}
                    type="button"
                    role="radio"
                    aria-checked={background === colour}
                    aria-label={colour}
                    className={styles.background}
                    style={{ background: colour }}
                    onClick={() => setBackground(colour)}
                  />
                ))}
              </div>
              <div className={styles.composeRow} style={{ padding: 0 }}>
                <button
                  type="button"
                  className={`${styles.composeButton} ${styles.composeSecondary}`}
                  onClick={() => setComposing(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.composeButton}
                  onClick={postText}
                  disabled={busy || !text.trim()}
                >
                  {busy ? "Posting…" : "Post"}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.composeRow}>
              <button
                type="button"
                className={`${styles.composeButton} ${styles.composeSecondary}`}
                onClick={() => setComposing(true)}
                disabled={busy}
              >
                Text status
              </button>
              <button
                type="button"
                className={styles.composeButton}
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                {busy ? "Posting…" : "Photo or video"}
              </button>
            </div>
          )}

          {mine.length > 0 && (
            <>
              <div className={styles.sectionLabel}>My status</div>
              {mine.map((reel) => (
                <Row key={reel.authorEmail} reel={reel} />
              ))}
            </>
          )}

          {theirs.length > 0 && (
            <>
              <div className={styles.sectionLabel}>Recent updates</div>
              {theirs.map((reel) => (
                <Row key={reel.authorEmail} reel={reel} />
              ))}
            </>
          )}

          {statuses.length === 0 && (
            <PaneEmpty>
              No status updates. Post one — it goes out encrypted to your contacts and disappears
              after 24 hours.
            </PaneEmpty>
          )}
        </PaneScroll>
      </Pane>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void postMedia(file);
        }}
      />

      {open && <StatusViewer reel={open} onClose={() => setOpen(null)} />}
    </AppShell>
  );
}
