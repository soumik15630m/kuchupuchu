"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { displayName, initials, loadContacts, saveContacts, type Contact } from "@/lib/contacts";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chats.module.css";

function preview(message: StoredMessage | null): string {
  if (!message) return "No messages yet";
  const prefix = message.outgoing ? "You: " : "";
  if (message.kind === "voice") return `${prefix}🎤 Voice note`;
  if (message.kind === "media") return `${prefix}📎 Attachment`;
  return prefix + message.body;
}

function timeLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

export default function ChatsPage() {
  const router = useRouter();
  const { chats, online, ready } = useMessaging();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => setContacts(loadContacts()), []);

  const rows = useMemo(() => {
    const byEmail = new Map<string, { email: string; name: string; summary: ReturnType<typeof chats.get> }>();
    for (const contact of contacts) {
      byEmail.set(contact.email, { email: contact.email, name: contact.name, summary: chats.get(contact.email) });
    }
    // A chat can exist with someone who was never added as a contact — a first
    // message from a member is not something to hide behind an "add" step.
    for (const [chatId, summary] of chats) {
      if (!byEmail.has(chatId)) {
        byEmail.set(chatId, { email: chatId, name: displayName(chatId, contacts), summary });
      }
    }

    const all = [...byEmail.values()].sort((a, b) => {
      const at = a.summary?.lastMessage?.sentAtMs ?? 0;
      const bt = b.summary?.lastMessage?.sentAtMs ?? 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name);
    });

    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.includes(q) ||
        (r.summary?.lastMessage?.body ?? "").toLowerCase().includes(q)
    );
  }, [contacts, chats, query]);

  function addContact() {
    const email = prompt("Their email address")?.trim().toLowerCase();
    if (!email) return;
    const name = prompt("Name for them")?.trim() || email;
    const next = [...contacts.filter((c) => c.email !== email), { email, name }];
    setContacts(next);
    saveContacts(next);
    router.push(`/chats/${encodeURIComponent(email)}`);
  }

  return (
    <AppShell detail={<PaneEmpty>Pick a chat to start reading.</PaneEmpty>}>
      <Pane>
        <PaneHeader title="Chats" />
        <div className={styles.searchWrap}>
          <div className={styles.search}>
            <Icon name="search" size={17} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search chats"
            />
          </div>
        </div>

        {ready && !online && <p className={styles.banner}>Reconnecting to the messaging service…</p>}

        <div className={styles.fabWrap}>
          <PaneScroll>
            {rows.length === 0 && (
              <PaneEmpty>
                {contacts.length === 0 ? "No chats yet. Add someone to begin." : "No matches."}
              </PaneEmpty>
            )}
            {rows.map((row) => (
              <button
                key={row.email}
                type="button"
                className={styles.item}
                onClick={() => router.push(`/chats/${encodeURIComponent(row.email)}`)}
              >
                <span className={styles.avatar}>{initials(row.name)}</span>
                <span className={styles.itemBody}>
                  <span className={styles.itemTop}>
                    <span className={styles.itemName}>{row.name}</span>
                    {row.summary?.lastMessage && (
                      <span className={styles.itemTime}>{timeLabel(row.summary.lastMessage.sentAtMs)}</span>
                    )}
                  </span>
                  <span className={styles.itemBottom}>
                    <span className={styles.itemPreview}>{preview(row.summary?.lastMessage ?? null)}</span>
                    {(row.summary?.unread ?? 0) > 0 && (
                      <span className={styles.unread}>{row.summary!.unread}</span>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </PaneScroll>

          <button className={styles.fab} type="button" onClick={addContact} aria-label="New chat">
            <Icon name="plus" size={24} />
          </button>
        </div>
      </Pane>
    </AppShell>
  );
}
