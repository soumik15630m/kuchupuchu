"use client";

import { useEffect } from "react";

import { Icon } from "@/components/Icon";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

/** Who received a message and who read it.
 *
 * The data has been stored per message all along -- `recipients`,
 * `deliveredTo` and `readBy` are what the aggregate tick is computed from --
 * and until now there was no way to see it. For a group that aggregate is
 * lossy by design: one grey tick means *someone* has not read it, and this
 * is the only place that says who.
 */
export function MessageInfo({
  message,
  nameFor,
  onClose,
}: {
  message: StoredMessage;
  nameFor: (email: string) => string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const recipients = message.recipients ?? [];
  const read = new Set(message.readBy ?? []);
  const delivered = new Set(message.deliveredTo ?? []);

  const rows = recipients.map((email) => ({
    email,
    state: read.has(email) ? "Read" : delivered.has(email) ? "Delivered" : "Sent",
  }));

  return (
    <div className={styles.menuBackdrop} onClick={onClose}>
      <div
        className={styles.forwardSheet}
        role="dialog"
        aria-modal="true"
        aria-label="Message info"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.forwardHeader}>
          <h2 className={styles.infoTitle}>Message info</h2>
          <button type="button" className={styles.emojiClose} aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <p className={styles.infoPreview}>{message.body || "Attachment"}</p>

        {rows.length === 0 ? (
          <p className={styles.infoEmpty}>
            No recipients recorded. Messages sent before this device knew who it was talking to
            don&apos;t carry the list.
          </p>
        ) : (
          <ul className={styles.infoList}>
            {rows.map((row) => (
              <li key={row.email} className={styles.infoRow}>
                <span className={styles.infoName}>{nameFor(row.email)}</span>
                <span className={styles.infoState} data-state={row.state.toLowerCase()}>
                  {row.state}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className={styles.infoNote}>
          {/* Said plainly rather than shown as a blank column: someone whose
              read receipts are off looks identical to someone who has not
              read it, and guessing which is worse than saying so. */}
          Someone who turned read receipts off will never show as Read here, however long they
          have had it.
        </p>
      </div>
    </div>
  );
}
