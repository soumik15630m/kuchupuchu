"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
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

function Media({ post }: { post: StatusPost }) {
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
    <video className={styles.stageMedia} src={url} autoPlay playsInline controls={false} />
  ) : (
    <img className={styles.stageMedia} src={url} alt={post.body || "Status"} />
  );
}

export function StatusViewer({ reel, onClose }: { reel: StatusReel; onClose: () => void }) {
  const { client } = useMessaging();
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const post = reel.posts[index];

  useEffect(() => {
    if (!post) return;
    void client?.markStatusViewed(post);
  }, [post, client]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (index + 1 < reel.posts.length) setIndex(index + 1);
      else onClose();
    }, SLIDE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [index, reel.posts.length, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, reel.posts.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, reel.posts.length]);

  if (!post) return null;

  return (
    <div className={styles.viewer} role="dialog" aria-label={`Status from ${reel.authorEmail}`}>
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
          {reel.outgoing ? "Your status" : reel.authorEmail}
          <span className={styles.viewerWhen}>{ago(post.postedAtMs)}</span>
        </div>
        <button className={styles.viewerClose} type="button" onClick={onClose} aria-label="Close status">
          <Icon name="plus" size={22} />
        </button>
      </div>

      <div className={styles.stage}>
        <Media post={post} />
        {post.media && post.body && <p className={styles.caption}>{post.body}</p>}

        <div className={styles.tapZones}>
          <button
            className={styles.tapZone}
            type="button"
            aria-label="Previous"
            onClick={() => (index > 0 ? setIndex(index - 1) : onClose())}
          />
          <button
            className={styles.tapZone}
            type="button"
            aria-label="Next"
            onClick={() => (index + 1 < reel.posts.length ? setIndex(index + 1) : onClose())}
          />
        </div>
      </div>

      <div className={styles.viewerFooter}>
        {reel.outgoing
          ? post.viewedBy.length === 0
            ? "No views yet"
            : `Seen by ${post.viewedBy.join(", ")}`
          : "Disappears 24 hours after it was posted"}
      </div>
    </div>
  );
}
