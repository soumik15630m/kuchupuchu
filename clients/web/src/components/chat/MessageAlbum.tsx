"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { albumColumns } from "@/lib/messaging/albums.mjs";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

/** Same set the bubble menu offers, so the two do not disagree. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
import { useDialog } from "@/lib/a11y/useDialog";

/** Several photos sent together, as one grid.
 *
 * Each cell is still its own message -- opening one opens that photo, and the
 * menu on the grid acts on the one that was tapped. The album is presentation
 * only; nothing here changes what was sent or what a receipt refers to.
 */
export function MessageAlbum({
  messages,
  urlFor,
  onOpen,
  onMenu,
}: {
  messages: StoredMessage[];
  urlFor: (message: StoredMessage) => Promise<string | undefined>;
  onOpen: (message: StoredMessage) => void;
  onMenu?: (message: StoredMessage) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved: Record<string, string | undefined> = {};
      for (const message of messages) {
        resolved[message.id] = await urlFor(message);
        // Set as each arrives rather than after all of them: a ten-photo
        // album would otherwise show nothing until the slowest one lands.
        if (cancelled) return;
        setUrls((prev) => ({ ...prev, ...resolved }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, urlFor]);

  const outgoing = messages[0].outgoing;

  return (
    <div className={`${styles.bubbleRow} ${outgoing ? styles.out : styles.in}`}>
      <div
        className={styles.album}
        style={{ gridTemplateColumns: `repeat(${albumColumns(messages.length)}, 1fr)` }}
        role="group"
        aria-label={`${messages.length} photos`}
      >
        {messages.map((message) => (
          <button
            key={message.id}
            type="button"
            className={styles.albumCell}
            aria-label={`Photo, ${new Date(message.sentAtMs).toLocaleTimeString()}`}
            onClick={() => onOpen(message)}
            onContextMenu={(e) => {
              if (!onMenu) return;
              e.preventDefault();
              onMenu(message);
            }}
          >
            {urls[message.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={urls[message.id]} alt="" className={styles.albumImage} />
            ) : message.media?.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={message.media.thumb} alt="" className={styles.albumImage} />
            ) : (
              <span className={styles.albumPending} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One album photo, full size.
 *
 * Its own small viewer rather than reusing the view-once one: that has a
 * blackout shield and destroys the blob on close, neither of which applies
 * to an ordinary photo.
 */
export function AlbumViewer({
  message,
  urlFor,
  onClose,
  onReply,
  onForward,
  onStar,
  onShowInfo,
  onReact,
  onTogglePin,
  pinned,
}: {
  message: StoredMessage;
  urlFor: (message: StoredMessage) => Promise<string | undefined>;
  onClose: () => void;
  /** A photo in a grid has no bubble menu, so the actions live here instead —
   * otherwise grouping silently costs a photo everything it could do. */
  onReply?: (message: StoredMessage) => void;
  onForward?: (message: StoredMessage) => void;
  onStar?: (message: StoredMessage) => void;
  onShowInfo?: (message: StoredMessage) => void;
  onReact?: (message: StoredMessage, emoji: string) => void;
  onTogglePin?: (message: StoredMessage, pin: boolean) => void;
  pinned?: boolean;
}) {
  const [url, setUrl] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void urlFor(message).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [message, urlFor]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, onClose);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={styles.albumViewer}
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      onClick={onClose}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className={styles.albumViewerImage} />
      ) : (
        <span className={styles.albumPending} />
      )}

      {onReact && (
        <div className={styles.albumViewerReactions} onClick={(e) => e.stopPropagation()}>
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              data-active={message.reactions && Object.values(message.reactions).includes(emoji)}
              onClick={() => onReact(message, emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <div
        className={styles.albumViewerBar}
        // The backdrop closes on click; the bar must not.
        onClick={(e) => e.stopPropagation()}
      >
        {onReply && (
          <button type="button" aria-label="Reply" onClick={() => { onReply(message); onClose(); }}>
            <Icon name="back" size={18} />
          </button>
        )}
        {onForward && (
          <button type="button" aria-label="Forward" onClick={() => { onForward(message); onClose(); }}>
            <Icon name="forward" size={18} />
          </button>
        )}
        {onStar && (
          <button
            type="button"
            aria-label={message.starred ? "Unstar" : "Star"}
            aria-pressed={Boolean(message.starred)}
            onClick={() => onStar(message)}
          >
            <Icon name="star" size={18} />
          </button>
        )}
        {onTogglePin && (
          <button
            type="button"
            aria-label={pinned ? "Unpin" : "Pin"}
            aria-pressed={Boolean(pinned)}
            onClick={() => onTogglePin(message, !pinned)}
          >
            <Icon name="pin" size={18} />
          </button>
        )}
        {onShowInfo && message.outgoing && (
          <button type="button" aria-label="Info" onClick={() => { onShowInfo(message); onClose(); }}>
            <Icon name="info" size={18} />
          </button>
        )}
        <button type="button" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}
