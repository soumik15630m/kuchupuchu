"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { FormattedText } from "@/components/chat/FormattedText";
import { useSession } from "@/lib/auth/SessionProvider";
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

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export function MessageBubble({
  message,
  mentionables,
  onReply,
  onReact,
  onDelete,
  onDeleteForMe,
  onEdit,
  onForward,
  onStar,
}: {
  message: StoredMessage;
  mentionables?: Map<string, string>;
  onReply?: (message: StoredMessage) => void;
  onReact?: (message: StoredMessage, emoji: string) => void;
  onDelete?: (message: StoredMessage) => void;
  onDeleteForMe?: (message: StoredMessage) => void;
  onEdit?: (message: StoredMessage) => void;
  onForward?: (message: StoredMessage) => void;
  onStar?: (message: StoredMessage) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { email: myEmail } = useSession();
  const reactions = Object.entries(message.reactions ?? {});

  if (message.kind === "system") {
    return (
      <div
        className={styles.systemNotice}
        data-kind={message.systemKind}
        role={message.systemKind === "security-code-changed" ? "alert" : undefined}
      >
        <Icon name="shield" size={13} />
        {message.body}
      </div>
    );
  }

  if (message.deletedForEveryone) {
    return (
      <div className={`${styles.bubble} ${message.outgoing ? styles.out : styles.in}`}>
        <span className={styles.deleted}>
          <Icon name="camOff" size={13} /> This message was deleted
        </span>
        <span className={styles.meta}>{formatTime(message.sentAtMs)}</span>
      </div>
    );
  }

  return (
    <div className={styles.bubbleRow} data-outgoing={message.outgoing ? "true" : undefined}>
      <div
        className={`${styles.bubble} ${message.outgoing ? styles.out : styles.in} ${
          message.kind === "sticker" ? styles.sticker : ""
        }`}
        data-kind={message.kind}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {message.replyTo && (
          <span className={styles.quote}>
            <span className={styles.quoteWho}>
              {message.replyTo.fromEmail === myEmail ? "You" : message.replyTo.fromEmail}
            </span>
            <span className={styles.quoteBody}>{message.replyTo.body || "Attachment"}</span>
          </span>
        )}

        {(message.kind === "media" || message.kind === "sticker") && (
          <MediaAttachment message={message} />
        )}
        {message.kind === "voice" && <VoiceNote message={message} />}
        {message.body && (
          <span className={styles.body}>
            <FormattedText body={message.body} mentionables={mentionables} selfEmail={myEmail} />
          </span>
        )}

        <span className={styles.meta}>
          {message.starred && <Icon name="check" size={11} />}
          {message.editedAtMs && <span className={styles.edited}>edited</span>}
          {formatTime(message.sentAtMs)}
          {message.outgoing && <Ticks status={message.status} />}
        </span>

        {reactions.length > 0 && (
          <span className={styles.reactions}>
            {reactions.map(([who, emoji]) => (
              <span key={who} title={who}>
                {emoji}
              </span>
            ))}
          </span>
        )}
      </div>

      <button
        type="button"
        className={styles.bubbleMenuButton}
        aria-label="Message actions"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <Icon name="chevron" size={14} />
      </button>

      {menuOpen && (
        <>
          <button
            type="button"
            className={styles.menuBackdrop}
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <div className={styles.bubbleMenu} role="menu">
            <div className={styles.quickReactions}>
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={styles.quickReaction}
                  data-active={message.reactions && Object.values(message.reactions).includes(emoji)}
                  onClick={() => {
                    onReact?.(message, emoji);
                    setMenuOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                onReply?.(message);
                setMenuOpen(false);
              }}
            >
              Reply
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                onForward?.(message);
                setMenuOpen(false);
              }}
            >
              Forward
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                onStar?.(message);
                setMenuOpen(false);
              }}
            >
              {message.starred ? "Unstar" : "Star"}
            </button>
            {message.outgoing && message.kind === "text" && (
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  onEdit?.(message);
                  setMenuOpen(false);
                }}
              >
                Edit
              </button>
            )}
            {message.body && (
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  void navigator.clipboard?.writeText(message.body);
                  setMenuOpen(false);
                }}
              >
                Copy
              </button>
            )}
            <button
              type="button"
              className={`${styles.menuItem} ${styles.menuDanger}`}
              onClick={() => {
                onDeleteForMe?.(message);
                setMenuOpen(false);
              }}
            >
              Delete for me
            </button>
            {message.outgoing && (
              <button
                type="button"
                className={`${styles.menuItem} ${styles.menuDanger}`}
                onClick={() => {
                  onDelete?.(message);
                  setMenuOpen(false);
                }}
              >
                Delete for everyone
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
