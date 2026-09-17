"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { useSession } from "@/lib/auth/SessionProvider";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";

import styles from "../chats.module.css";
import themeStyles from "@/app/settings/theme/theme.module.css";

export default function NewChatPage() {
  const router = useRouter();
  const { session } = useSession();
  const { others, loading, refresh } = useDirectory();
  const [query, setQuery] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return others;
    return others.filter(
      (m) =>
        (m.username ?? "").toLowerCase().includes(q) ||
        (m.displayName ?? "").toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q)
    );
  }, [others, query]);

  /** The directory already holds every member, so this only matters if the
   * cached copy is stale — someone who joined since the last refresh. */
  async function lookupExact() {
    const handle = query.trim().replace(/^@/, "");
    if (!handle || !session) return;
    setLookupError(null);
    try {
      const member = await session.lookupUsername(handle);
      await refresh();
      router.push(`/chats/${encodeURIComponent(member.email)}`);
    } catch {
      setLookupError(`No member with the username "${handle}".`);
    }
  }

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader title="New chat" backHref="/chats" />
        <div className={styles.searchWrap}>
          <div className={styles.search}>
            <Icon name="search" size={17} />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLookupError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void lookupExact();
              }}
              placeholder="Search by username or name"
              aria-label="Search members"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </div>

        <PaneScroll>
          <button
            type="button"
            className={styles.item}
            onClick={() => router.push("/chats/new-group")}
          >
            <span className={styles.avatar} style={{ background: "var(--bg-sunken)", color: "var(--accent)" }}>
              <Icon name="status" size={20} />
            </span>
            <span className={styles.itemBody}>
              <span className={styles.itemName}>New group</span>
              <span className={styles.itemPreview}>Message several people at once</span>
            </span>
          </button>

          {loading && shown.length === 0 && <PaneEmpty>Loading members…</PaneEmpty>}

          {!loading && shown.length === 0 && (
            <PaneEmpty>
              {query.trim() ? "No member matches that." : "No other members yet."}
            </PaneEmpty>
          )}

          {shown.map((member) => (
            <button
              key={member.email}
              type="button"
              className={styles.item}
              onClick={() => router.push(`/chats/${encodeURIComponent(member.email)}`)}
            >
              <span className={styles.avatar}>
                {initialsFor(member.displayName || member.username || member.email)}
              </span>
              <span className={styles.itemBody}>
                <span className={styles.itemName}>
                  {member.displayName || member.username || member.email}
                </span>
                <span className={styles.itemPreview}>
                  {member.username ? `@${member.username}` : member.email}
                  {member.about ? ` · ${member.about}` : ""}
                </span>
              </span>
            </button>
          ))}

          {lookupError && <p className={themeStyles.hint} style={{ padding: "0 16px" }}>{lookupError}</p>}
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
