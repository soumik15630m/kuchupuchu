"use client";

import { useEffect, useState } from "react";

import { albumColumns } from "@/lib/messaging/albums.mjs";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

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
}: {
  message: StoredMessage;
  urlFor: (message: StoredMessage) => Promise<string | undefined>;
  onClose: () => void;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
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
    </div>
  );
}
