"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { useDirectory } from "@/lib/directory/DirectoryProvider";
import { isGroupId } from "@/lib/groups";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { messagesFor, type StoredMessage } from "@/lib/messaging/store";

import styles from "./media.module.css";

type Tab = "media" | "files" | "links";

const LINK_PATTERN = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;

export default function ChatMediaPage() {
  const params = useParams<{ email: string }>();
  const email = decodeURIComponent(params.email);
  const { nameFor } = useDirectory();
  const { client, revision } = useMessaging();
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [tab, setTab] = useState<Tab>("media");

  useEffect(() => {
    messagesFor(email).then((all) => setMessages(all.sort((a, b) => b.sentAtMs - a.sentAtMs)));
  }, [email, revision]);

  const media = useMemo(
    // View-once attachments never belong in a gallery: the whole point is that
    // there is no second look.
    () => messages.filter((m) => !m.viewOnce && (m.kind === "media" || m.kind === "sticker")),
    [messages]
  );
  const files = useMemo(
    () => messages.filter((m) => m.kind === "file" || m.kind === "voice"),
    [messages]
  );
  const links = useMemo(
    () =>
      messages.flatMap((m) => {
        const found = m.body.match(LINK_PATTERN) ?? [];
        return found.map((url) => ({ message: m, url }));
      }),
    [messages]
  );

  const title = isGroupId(email) ? "Group" : nameFor(email);

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader
          title="Media, links and docs"
          subtitle={title}
          backHref={`/chats/${encodeURIComponent(email)}/settings`}
        />

        <div className={styles.tabs}>
          {(["media", "files", "links"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={styles.tab}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t === "media" ? `Media ${media.length}` : t === "files" ? `Docs ${files.length}` : `Links ${links.length}`}
            </button>
          ))}
        </div>

        <PaneScroll>
          {tab === "media" && (
            <div className={styles.grid}>
              {media.length === 0 && <PaneEmpty>Nothing shared yet.</PaneEmpty>}
              {media.map((m) => (
                <MediaThumb key={m.id} message={m} />
              ))}
            </div>
          )}

          {tab === "files" && (
            <>
              {files.length === 0 && <PaneEmpty>No documents or voice notes.</PaneEmpty>}
              {files.map((m) => (
                <div key={m.id} className={styles.row}>
                  <span className={styles.rowIcon}>
                    <Icon name={m.kind === "voice" ? "mic" : "attach"} size={18} />
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowName}>
                      {m.kind === "voice" ? "Voice note" : m.media?.name ?? "Document"}
                    </span>
                    <span className={styles.rowMeta}>
                      {new Date(m.sentAtMs).toLocaleDateString()}
                    </span>
                  </span>
                </div>
              ))}
            </>
          )}

          {tab === "links" && (
            <>
              {links.length === 0 && <PaneEmpty>No links shared.</PaneEmpty>}
              {links.map(({ message, url }, i) => (
                <div key={`${message.id}-${i}`} className={styles.row}>
                  <span className={styles.rowIcon}>
                    <Icon name="search" size={18} />
                  </span>
                  <span className={styles.rowBody}>
                    <a
                      className={styles.rowName}
                      href={url.startsWith("http") ? url : `https://${url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {url}
                    </a>
                    <span className={styles.rowMeta}>
                      {new Date(message.sentAtMs).toLocaleDateString()}
                    </span>
                  </span>
                </div>
              ))}
            </>
          )}
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}

/** Thumbnails come from the envelope, so the grid renders without fetching
 * and decrypting every blob. */
function MediaThumb({ message }: { message: StoredMessage }) {
  const { client } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return (
    <button
      type="button"
      className={styles.thumb}
      onClick={async () => {
        if (url || !client || !message.media) return;
        const blob = await client.fetchMedia(message.media);
        setUrl(URL.createObjectURL(blob));
      }}
    >
      {url ? (
        <img src={url} alt={message.media?.name ?? "Attachment"} />
      ) : message.media?.thumb ? (
        <img src={message.media.thumb} alt="" />
      ) : (
        <span className={styles.thumbIcon}>
          <Icon name="image" size={20} />
        </span>
      )}
    </button>
  );
}
