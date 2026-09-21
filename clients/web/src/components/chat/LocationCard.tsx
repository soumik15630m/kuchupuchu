"use client";

import { Icon } from "@/components/Icon";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

/** Coordinates rendered as text plus an opt-in link.
 *
 * No map tile is embedded on purpose: fetching one would tell a tile server
 * both people's IP and the exact coordinates being looked at, which defeats
 * the point of sending it over an encrypted channel. The link is there if the
 * user chooses to make that trade. */
export function LocationCard({ message }: { message: StoredMessage }) {
  const location = message.location;
  if (!location) return null;

  const { lat, lon, accuracyM } = location;
  const label = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;

  return (
    <div className={styles.fileCard}>
      <span className={styles.fileIcon}>
        <Icon name="status" size={20} />
      </span>
      <span className={styles.fileBody}>
        <span className={styles.fileName}>{label}</span>
        <span className={styles.fileMeta}>
          {accuracyM ? `Accurate to about ${Math.round(accuracyM)} m · ` : ""}
          <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
            Open map
          </a>
        </span>
      </span>
    </div>
  );
}

export function ContactCard({ message }: { message: StoredMessage }) {
  const { nameFor } = useDirectory();
  const contact = message.contact;
  if (!contact) return null;

  const label = contact.displayName || contact.username || nameFor(contact.email);

  return (
    <div className={styles.fileCard}>
      <span className={styles.fileIcon} style={{ borderRadius: "50%" }}>
        {initialsFor(label)}
      </span>
      <span className={styles.fileBody}>
        <span className={styles.fileName}>{label}</span>
        <span className={styles.fileMeta}>
          {contact.username ? `@${contact.username}` : contact.email}
        </span>
      </span>
    </div>
  );
}
