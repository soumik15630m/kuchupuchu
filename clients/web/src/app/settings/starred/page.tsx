"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { isGroupId } from "@/lib/groups";
import { searchableText, setStarred, starredMessages, type StoredMessage } from "@/lib/messaging/store";

import styles from "@/app/chats/chats.module.css";

export default function StarredPage() {
  const router = useRouter();
  const { nameFor } = useDirectory();
  const [messages, setMessages] = useState<StoredMessage[] | null>(null);

  const load = useCallback(() => {
    starredMessages().then(setMessages);
  }, []);

  useEffect(load, [load]);

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="Starred messages" backHref="/settings" />
        <PaneScroll>
          {messages === null && <PaneEmpty>Loading…</PaneEmpty>}
          {messages?.length === 0 && (
            <PaneEmpty>Star a message from its menu to keep it here.</PaneEmpty>
          )}

          {messages?.map((message) => {
            const who = isGroupId(message.chatId) ? "Group" : nameFor(message.chatId);
            return (
              <div key={message.id} className={styles.itemRow}>
                <button
                  type="button"
                  className={styles.item}
                  onClick={() => router.push(`/chats/${encodeURIComponent(message.chatId)}`)}
                >
                  <span className={styles.avatar}>{initialsFor(who)}</span>
                  <span className={styles.itemBody}>
                    <span className={styles.itemTop}>
                      <span className={styles.itemName}>{who}</span>
                      <span className={styles.itemTime}>
                        {new Date(message.sentAtMs).toLocaleDateString()}
                      </span>
                    </span>
                    <span className={styles.itemPreview}>{searchableText(message)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.itemMenuButton}
                  aria-label="Unstar"
                  onClick={async () => {
                    await setStarred(message.id, false);
                    load();
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
