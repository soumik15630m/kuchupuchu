"use client";

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Anything that is not an image, video or audio: a document card that
 * downloads on demand rather than trying to render something it cannot. */
export function FileAttachment({ message }: { message: StoredMessage }) {
  const { client } = useMessaging();
  const [busy, setBusy] = useState(false);
  const media = message.media;
  if (!media) return null;

  async function download() {
    if (!client || !media) return;
    setBusy(true);
    try {
      const blob = await client.fetchMedia(media);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = media.name || "attachment";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on a delay: revoking immediately can cancel the download in
      // some browsers before it has actually started.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={styles.fileCard} onClick={download} disabled={busy}>
      <span className={styles.fileIcon}>
        <Icon name="attach" size={20} />
      </span>
      <span className={styles.fileBody}>
        <span className={styles.fileName}>{media.name || "Attachment"}</span>
        <span className={styles.fileMeta}>
          {busy ? "Downloading…" : `${formatSize(media.byteSize)} · tap to download`}
        </span>
      </span>
    </button>
  );
}
