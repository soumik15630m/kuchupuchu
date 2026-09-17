"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initials, loadContacts, saveContacts, type Contact } from "@/lib/contacts";

import styles from "./chats.module.css";

export default function ChatsPage() {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => setContacts(loadContacts()), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q) || c.email.includes(q));
  }, [contacts, query]);

  function addContact() {
    const email = prompt("Their email address")?.trim().toLowerCase();
    if (!email) return;
    const name = prompt("Name for them")?.trim() || email;
    const next = [...contacts.filter((c) => c.email !== email), { email, name }];
    setContacts(next);
    saveContacts(next);
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

        <p className={styles.banner}>
          Messages are stored on this device only — the messaging service isn&apos;t built yet, so
          nothing is sent or received.
        </p>

        <div className={styles.fabWrap}>
          <PaneScroll>
            {shown.length === 0 && (
              <PaneEmpty>
                {contacts.length === 0 ? "No chats yet. Add someone to begin." : "No matches."}
              </PaneEmpty>
            )}
            {shown.map((c) => (
              <button
                key={c.email}
                type="button"
                className={styles.item}
                onClick={() => router.push(`/chats/${encodeURIComponent(c.email)}`)}
              >
                <span className={styles.avatar}>{initials(c.name)}</span>
                <span className={styles.itemBody}>
                  <span className={styles.itemTop}>
                    <span className={styles.itemName}>{c.name}</span>
                  </span>
                  <span className={styles.itemPreview}>{c.email}</span>
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
