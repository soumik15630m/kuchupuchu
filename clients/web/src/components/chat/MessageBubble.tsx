"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { FileAttachment } from "@/components/chat/FileAttachment";
import { FormattedText } from "@/components/chat/FormattedText";
import { LinkPreviewCard } from "@/components/chat/LinkPreviewCard";
import { ContactCard, LocationCard } from "@/components/chat/LocationCard";
import { VoicePlayer } from "@/components/chat/VoicePlayer";
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

/** A view-once attachment: one tap, shown full-screen, then gone from this
 * device. The wording is deliberately plain about what this does and does not
 * prevent -- no client-side feature can stop the other person photographing
 * their own screen, and implying otherwise would be the harmful part. */
function ViewOnceAttachment({
  message,
  onOpened,
}: {
  message: StoredMessage;
  onOpened?: (message: StoredMessage) => void;
}) {
  const { client } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const media = message.media;

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  if (message.outgoing) {
    return (
      <span className={styles.viewOnceChip} data-spent={message.viewedOnceAtMs ? "true" : undefined}>
        <Icon name="image" size={15} />
        {message.viewedOnceAtMs ? "Opened" : "Photo · view once"}
      </span>
    );
  }

  if (message.viewedOnceAtMs || !media) {
    return (
      <span className={styles.viewOnceChip} data-spent="true">
        <Icon name="image" size={15} />
        Opened
      </span>
    );
  }

  async function open() {
    if (!client || !media || loading) return;
    setLoading(true);
    try {
      const blob = await client.fetchMedia(media);
      setUrl(URL.createObjectURL(blob));
    } catch {
      setLoading(false);
    }
  }

  function close() {
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
    onOpened?.(message);
  }

  return (
    <>
      <button type="button" className={styles.viewOnceChip} onClick={open} disabled={loading}>
        <Icon name="image" size={15} />
        {loading ? "Opening…" : "Tap to view once"}
      </button>
      {url && (
        <div className={styles.viewOnceViewer} role="dialog" aria-label="View once photo">
          {media.mime.startsWith("video/") ? (
            <video src={url} controls autoPlay playsInline onEnded={close} />
          ) : (
            <img src={url} alt="" />
          )}
          <button type="button" onClick={close}>
            Done
          </button>
          <p>Closing this removes it from your device. It cannot prevent a screenshot.</p>
        </div>
      )}
    </>
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
  onViewOnceOpened,
}: {
  message: StoredMessage;
  mentionables?: Map<string, string>;
  onViewOnceOpened?: (message: StoredMessage) => void;
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

        {message.viewOnce ? (
          <ViewOnceAttachment message={message} onOpened={onViewOnceOpened} />
        ) : (
          (message.kind === "media" || message.kind === "sticker") && (
            <MediaAttachment message={message} />
          )
        )}
        {message.kind === "voice" && <VoicePlayer message={message} />}
        {message.kind === "file" && <FileAttachment message={message} />}
        {message.kind === "location" && <LocationCard message={message} />}
        {message.kind === "contact" && <ContactCard message={message} />}
        {message.link && !message.deletedForEveryone && <LinkPreviewCard preview={message.link} />}
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
