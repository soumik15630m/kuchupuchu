"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useDialog } from "@/lib/a11y/useDialog";
import { useDirectory } from "@/lib/directory/DirectoryProvider";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import type { StatusPost, StatusReel } from "@/lib/messaging/status-store";

import styles from "@/app/status/status.module.css";

const SLIDE_MS = 6000;

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function Media({ post, onDuration }: { post: StatusPost; onDuration?: (ms: number) => void }) {
  const { client } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!post.media || !client) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    client
      .fetchMedia(post.media)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [post.media, client]);

  if (!post.media) {
    return (
      <div className={styles.textCard} style={{ background: post.background ?? "var(--accent)" }}>
        {post.body}
      </div>
    );
  }
  if (!url) return <div className={styles.textCard} style={{ background: "#222" }}>Loading…</div>;

  return post.media.mime.startsWith("video/") ? (
    <video
      className={styles.stageMedia}
      src={url}
      autoPlay
      playsInline
      // muted is not cosmetic: Chrome refuses to autoplay a video with sound
      // without a gesture, so without this a video status silently never
      // played at all.
      muted
      controls={false}
      // A fixed six seconds cut a longer clip off mid-sentence. The slide
      // waits for the video instead, capped so a broken file cannot wedge it.
      onLoadedMetadata={(e) => onDuration?.(e.currentTarget.duration * 1000)}
    />
  ) : (
    <img className={styles.stageMedia} src={url} alt={post.body || "Status"} />
  );
}

export function StatusViewer({ reel, onClose }: { reel: StatusReel; onClose: () => void }) {
  const { client } = useMessaging();
  const { nameFor } = useDirectory();
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [slideMs, setSlideMs] = useState(SLIDE_MS);
  const [reply, setReply] = useState("");
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const post = reel.posts[index];

  useDialog(viewerRef, onClose, { autoFocus: false });

  // Only what is actually on screen counts as seen. The timer used to keep
  // advancing in a hidden tab, so a backgrounded reel told its author you had
  // watched posts you never looked at.
  useEffect(() => {
    if (!post || document.visibilityState !== "visible") return;
    void client?.markStatusViewed(post);
  }, [post, client]);

  const advance = useCallback(() => {
    setIndex((i) => {
      if (i + 1 < reel.posts.length) return i + 1;
      onClose();
      return i;
    });
  }, [reel.posts.length, onClose]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    // Paused while held, and while the tab is hidden — a reel should not run
    // out behind someone's back.
    if (held || typing(reply) || document.visibilityState !== "visible") return;
    timer.current = setTimeout(advance, slideMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [index, advance, held, reply, slideMs]);

  // Re-evaluate when the tab comes back, so a reel resumes rather than
  // sitting frozen on whatever slide it was on.
  useEffect(() => {
    const onVisible = () => setHeld((h) => h);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    setSlideMs(SLIDE_MS);
    setSent(false);
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(reply)) return;
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, reel.posts.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [reel.posts.length, reply]);

  if (!post) return null;

  const who = reel.outgoing ? "Your status" : nameFor(reel.authorEmail);

  return (
    <div
      ref={viewerRef}
      className={styles.viewer}
      role="dialog"
      aria-modal="true"
      aria-label={`Status from ${who}`}
    >
      <div className={styles.progress}>
        {reel.posts.map((p, i) => (
          <span key={p.id} className={styles.progressBar}>
            <span
              className={styles.progressFill}
              data-state={i < index ? "done" : i === index ? "active" : undefined}
            />
          </span>
        ))}
      </div>

      <div className={styles.viewerHeader}>
        <div className={styles.viewerWho}>
          {who}
          <span className={styles.viewerWhen}>{ago(post.postedAtMs)}</span>
        </div>
        <button className={styles.viewerClose} type="button" onClick={onClose} aria-label="Close status">
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className={styles.stage}>
        <Media post={post} onDuration={(ms) => setSlideMs(Math.min(Math.max(ms, 2000), 60_000))} />
        {post.media && post.body && <p className={styles.caption}>{post.body}</p>}

        <div className={styles.tapZones}>
          <button
            className={styles.tapZone}
            type="button"
            aria-label="Previous"
            onClick={() => (index > 0 ? setIndex(index - 1) : onClose())}
            // Press and hold pauses, the way every other story viewer does.
            onPointerDown={() => setHeld(true)}
            onPointerUp={() => setHeld(false)}
            onPointerLeave={() => setHeld(false)}
          />
          <button
            className={styles.tapZone}
            type="button"
            aria-label="Next"
            onClick={() => (index + 1 < reel.posts.length ? setIndex(index + 1) : onClose())}
            onPointerDown={() => setHeld(true)}
            onPointerUp={() => setHeld(false)}
            onPointerLeave={() => setHeld(false)}
          />
        </div>
      </div>

      <div className={styles.viewerFooter}>
        {reel.outgoing ? (
          post.viewedBy.length === 0 ? (
            "No views yet"
          ) : (
            // Names, not addresses. The raw list read as a database row.
            `Seen by ${post.viewedBy.map(nameFor).join(", ")}`
          )
        ) : (
          <form
            className={styles.replyForm}
            onSubmit={async (e) => {
              e.preventDefault();
              const text = reply.trim();
              if (!text) return;
              setReply("");
              await client?.replyToStatus(post, text);
              setSent(true);
            }}
          >
            <input
              className={styles.replyInput}
              value={reply}
              placeholder={sent ? "Sent — reply again?" : `Reply to ${who}`}
              aria-label={`Reply to ${who}`}
              onChange={(e) => setReply(e.target.value)}
            />
            <button type="submit" className={styles.replySend} aria-label="Send reply" disabled={!reply.trim()}>
              <Icon name="send" size={18} />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Whether a reply is being written — the reel must not advance out from
 * under someone mid-sentence, and arrow keys belong to the field. */
function typing(reply: string): boolean {
  return reply.trim().length > 0;
}
