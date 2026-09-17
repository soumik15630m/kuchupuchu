"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initials, loadContacts, type Contact } from "@/lib/contacts";

import styles from "../chats/chats.module.css";

export default function CallsPage() {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => setContacts(loadContacts()), []);

  return (
    <AppShell detail={<PaneEmpty>Start a call from the list.</PaneEmpty>}>
      <Pane>
        <PaneHeader title="Calls" />
        <PaneScroll>
          {contacts.length === 0 && <PaneEmpty>Add someone in Chats first.</PaneEmpty>}
          {contacts.map((c) => (
            <div key={c.email} className={styles.item}>
              <span className={styles.avatar}>{initials(c.name)}</span>
              <span className={styles.itemBody}>
                <span className={styles.itemName}>{c.name}</span>
                <span className={styles.itemPreview}>{c.email}</span>
              </span>
              <button
                type="button"
                aria-label={`Voice call ${c.name}`}
                onClick={() => router.push(`/call/${encodeURIComponent(c.email)}`)}
                style={{ color: "var(--accent)", padding: 8 }}
              >
                <Icon name="phone" size={20} />
              </button>
              <button
                type="button"
                aria-label={`Video call ${c.name}`}
                onClick={() => router.push(`/call/${encodeURIComponent(c.email)}?video=1`)}
                style={{ color: "var(--accent)", padding: 8 }}
              >
                <Icon name="video" size={21} />
              </button>
            </div>
          ))}
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
