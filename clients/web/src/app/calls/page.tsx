"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";

import styles from "../chats/chats.module.css";

export default function CallsPage() {
  const router = useRouter();
  const { others, nameFor } = useDirectory();

  return (
    <AppShell detail={<PaneEmpty>Start a call from the list.</PaneEmpty>}>
      <Pane>
        <PaneHeader title="Calls" />
        <PaneScroll>
          {others.length === 0 && <PaneEmpty>No other members yet.</PaneEmpty>}
          {others.map((c) => (
            <div key={c.email} className={styles.item}>
              <span className={styles.avatar}>{initialsFor(nameFor(c.email))}</span>
              <span className={styles.itemBody}>
                <span className={styles.itemName}>{nameFor(c.email)}</span>
                <span className={styles.itemPreview}>{c.username ? `@${c.username}` : c.email}</span>
              </span>
              <button
                type="button"
                aria-label={`Voice call ${nameFor(c.email)}`}
                onClick={() => router.push(`/call/${encodeURIComponent(c.email)}`)}
                style={{ color: "var(--accent)", padding: 8 }}
              >
                <Icon name="phone" size={20} />
              </button>
              <button
                type="button"
                aria-label={`Video call ${nameFor(c.email)}`}
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
