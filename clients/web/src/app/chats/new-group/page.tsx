"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { useSession } from "@/lib/auth/SessionProvider";
import { initials, loadContacts, type Contact } from "@/lib/contacts";
import { createGroup } from "@/lib/groups";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

import styles from "../chats.module.css";
import themeStyles from "@/app/settings/theme/theme.module.css";

// §4 caps a call at 5 participants. A group chat has no such limit, but the
// allowlist itself is capped at 10 (§1), so a group cannot exceed that.
const MAX_MEMBERS = 10;

export default function NewGroupPage() {
  const router = useRouter();
  const { email } = useSession();
  const { refreshChats } = useMessaging();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");

  useEffect(() => setContacts(loadContacts()), []);

  function toggle(contactEmail: string) {
    setSelected((prev) =>
      prev.includes(contactEmail)
        ? prev.filter((e) => e !== contactEmail)
        : prev.length + 1 >= MAX_MEMBERS
          ? prev
          : [...prev, contactEmail]
    );
  }

  function create() {
    if (!email || selected.length === 0) return;
    const group = createGroup(name, selected, email);
    refreshChats();
    router.replace(`/chats/${encodeURIComponent(group.id)}`);
  }

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="New group" backHref="/chats" />
        <PaneScroll>
          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>Group name</h2>
            <input
              className={themeStyles.hexInput}
              style={{ width: "100%", fontFamily: "inherit", textTransform: "none" }}
              value={name}
              placeholder="Group name"
              aria-label="Group name"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className={themeStyles.section}>
            <h2 className={themeStyles.sectionTitle}>
              Members {selected.length > 0 && `· ${selected.length + 1}`}
            </h2>
            {contacts.length === 0 && <PaneEmpty>Add contacts in Chats first.</PaneEmpty>}
            {contacts.map((contact) => {
              const on = selected.includes(contact.email);
              return (
                <button
                  key={contact.email}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={styles.item}
                  onClick={() => toggle(contact.email)}
                >
                  <span className={styles.avatar}>{initials(contact.name)}</span>
                  <span className={styles.itemBody}>
                    <span className={styles.itemName}>{contact.name}</span>
                    <span className={styles.itemPreview}>{contact.email}</span>
                  </span>
                  {on && (
                    <span style={{ color: "var(--accent)" }}>
                      <Icon name="check" size={20} />
                    </span>
                  )}
                </button>
              );
            })}
            <p className={themeStyles.hint}>
              You are always a member. Everyone gets their own encrypted copy of each message.
            </p>
          </div>

          <div className={themeStyles.resetRow}>
            <button
              type="button"
              className={themeStyles.sheetClose ?? ""}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: "var(--radius-pill)",
                background: "var(--accent)",
                color: "var(--accent-ink)",
                fontWeight: 600,
                opacity: selected.length === 0 ? 0.5 : 1,
              }}
              disabled={selected.length === 0}
              onClick={create}
            >
              Create group
            </button>
          </div>
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
