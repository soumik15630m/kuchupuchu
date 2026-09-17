"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

function Ticks({ status }: { status: StoredMessage["status"] }) {
  if (status === "sending") return <span className={styles.tick}>·</span>;
  if (status === "failed")
    return (
      <span className={styles.tick} data-failed="true" title="Not sent">
        !
      </span>
    );
  return (
    <span className={styles.tick} data-read={status === "read" ? "true" : undefined}>
      {status === "sent" ? "✓" : "✓✓"}
    </span>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function VoiceNote({ message }: { message: StoredMessage }) {
  const { client } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  async function load() {
    if (url || !client || !message.media) return;
    setLoading(true);
    try {
      const blob = await client.fetchMedia(message.media);
      setUrl(URL.createObjectURL(blob));
    } catch {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (url) audioRef.current?.play().catch(() => {});
  }, [url]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return (
    <div className={styles.voice}>
      {url ? (
        <audio ref={audioRef} className={styles.audio} src={url} controls preload="none" />
      ) : (
        <button type="button" className={styles.voicePlay} onClick={load} disabled={loading}>
          <Icon name={loading ? "mic" : "send"} size={16} />
          <span>{loading ? "Loading…" : "Play voice note"}</span>
        </button>
      )}
      {message.media?.durationMs != null && (
        <span className={styles.voiceLength}>{formatDuration(message.media.durationMs)}</span>
      )}
    </div>
  );
}

function MediaAttachment({ message }: { message: StoredMessage }) {
  const { client } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const media = message.media;

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  if (!media) return null;
  const isVideo = media.mime.startsWith("video/");

  async function open() {
    if (url || !client || !media) return;
    setLoading(true);
    try {
      const blob = await client.fetchMedia(media);
      setUrl(URL.createObjectURL(blob));
    } finally {
      setLoading(false);
    }
  }

  if (url) {
    return isVideo ? (
      <video className={styles.media} src={url} controls playsInline />
    ) : (
      <img className={styles.media} src={url} alt={media.name ?? "Attachment"} />
    );
  }

  return (
    <button type="button" className={styles.mediaPlaceholder} onClick={open} disabled={loading}>
      {media.thumb ? (
        <img className={styles.media} src={media.thumb} alt="" data-blur="true" />
      ) : (
        <span className={styles.mediaIcon}>
          <Icon name={isVideo ? "video" : "image"} size={26} />
        </span>
      )}
      <span className={styles.mediaBadge}>
        {loading ? "Downloading…" : isVideo ? "Tap to play" : "Tap to load"}
      </span>
    </button>
  );
}

export function MessageBubble({ message }: { message: StoredMessage }) {
  return (
    <div
      className={`${styles.bubble} ${message.outgoing ? styles.out : styles.in}`}
      data-kind={message.kind}
    >
      {message.kind === "media" && <MediaAttachment message={message} />}
      {message.kind === "voice" && <VoiceNote message={message} />}
      {message.body && <span className={styles.body}>{message.body}</span>}

      <span className={styles.meta}>
        {formatTime(message.sentAtMs)}
        {message.outgoing && <Ticks status={message.status} />}
      </span>
    </div>
  );
}
