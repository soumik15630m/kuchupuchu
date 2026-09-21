"use client";

import type { LinkPreview } from "@/lib/messaging/store";

import styles from "./chat.module.css";

/** Renders a preview the sender already resolved. Nothing here reaches out:
 * the image is an inline data URL, and the card is only a link once clicked. */
export function LinkPreviewCard({
  preview,
  onDismiss,
}: {
  preview: LinkPreview;
  onDismiss?: () => void;
}) {
  let host = preview.url;
  try {
    host = new URL(preview.url).host.replace(/^www\./, "");
  } catch {
    // Keep the raw string; it was link-shaped enough to get a preview.
  }

  const body = (
    <>
      {preview.image && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={preview.image} alt="" className={styles.linkImage} />
      )}
      <span className={styles.linkText}>
        <span className={styles.linkSite}>{preview.siteName || host}</span>
        {preview.title && <span className={styles.linkTitle}>{preview.title}</span>}
        {preview.description && <span className={styles.linkDesc}>{preview.description}</span>}
      </span>
    </>
  );

  if (onDismiss) {
    return (
      <div className={styles.linkCard}>
        {body}
        <button type="button" className={styles.linkDismiss} onClick={onDismiss} aria-label="Remove preview">
          ×
        </button>
      </div>
    );
  }

  return (
    <a
      className={styles.linkCard}
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      {body}
    </a>
  );
}
