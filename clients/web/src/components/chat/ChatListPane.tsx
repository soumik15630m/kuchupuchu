"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { getGroup, isGroupId, loadGroups, type Group } from "@/lib/groups";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import {
  describeMessage,
  searchMessages,
  searchableText,
  type SearchHit,
  type StoredMessage,
} from "@/lib/messaging/store";
import {
  isMuted,
  loadChatSettings,
  MUTE_DURATIONS,
  updateChatSettings,
  type ChatSettings,
} from "@/lib/messaging/chat-settings";

import styles from "@/app/chats/chats.module.css";

function preview(message: StoredMessage | null): string {
  if (!message) return "No messages yet";
  return (message.outgoing ? "You: " : "") + describeMessage(message);
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

/** The chat list.
 *
 * Extracted from the chats page so the shell can keep it beside an open
 * conversation on a wide screen. Opening a chat used to empty the sidebar
 * entirely, leaving a blank column on desktop and no way to switch
 * conversations without going Back first.
 */
export function ChatListPane() {
  const router = useRouter();
  const { chats, online, ready } = useMessaging();
  const { others, nameFor } = useDirectory();
  const [groups, setGroups] = useState<Group[]>([]);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<Record<string, ChatSettings>>({});
  const [showArchived, setShowArchived] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  useEffect(() => {
    setGroups(loadGroups());
    setSettings(loadChatSettings());
  }, [chats]);

  // Searching message bodies is a separate pass from filtering the chat list:
  // the list matches names, this matches history.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      searchMessages(term).then((found) => {
        if (!cancelled) setHits(found);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  function patch(chatId: string, next: ChatSettings) {
    setSettings(updateChatSettings(chatId, next));
    setMenuFor(null);
  }

  // A chat id is either a member's address or a group id; this resolves both,
  // so the list stops rendering the literal string "Group" for a group whose
  // name it already has.
  const titleFor = (chatId: string) =>
    isGroupId(chatId) ? (getGroup(chatId)?.name ?? "Group") : nameFor(chatId);

  // Shown only when there is something in it -- a permanent row on a fresh
  // account is a dead end.
  const hasArchived = Object.values(settings).some((s) => s?.archived);

  const rows = useMemo(() => {
    type Row = { email: string; name: string; group: boolean; summary: ReturnType<typeof chats.get> };
    const byEmail = new Map<string, Row>();
    // Only members you have actually spoken to appear here; the rest live
    // behind "new chat" rather than padding the list with empty threads.
    for (const member of others) {
      if (!chats.has(member.email)) continue;
      byEmail.set(member.email, {
        email: member.email,
        name: nameFor(member.email),
        group: false,
        summary: chats.get(member.email),
      });
    }
    for (const group of groups) {
      byEmail.set(group.id, {
        email: group.id,
        name: group.name,
        group: true,
        summary: chats.get(group.id),
      });
    }
    // A chat can exist with someone who was never added as a contact — a first
    // message from a member is not something to hide behind an "add" step.
    for (const [chatId, summary] of chats) {
      if (!byEmail.has(chatId)) {
        byEmail.set(chatId, {
          email: chatId,
          name: titleFor(chatId),
          group: isGroupId(chatId),
          summary,
        });
      }
    }

    const all = [...byEmail.values()].sort((a, b) => {
      // Pinned chats stay on top regardless of recency; that is the whole point.
      const ap = settings[a.email]?.pinned ? 1 : 0;
      const bp = settings[b.email]?.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const at = a.summary?.lastMessage?.sentAtMs ?? 0;
      const bt = b.summary?.lastMessage?.sentAtMs ?? 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name);
    }).filter((row) => Boolean(settings[row.email]?.archived) === showArchived);

    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.includes(q) ||
        (r.summary?.lastMessage?.body ?? "").toLowerCase().includes(q)
    );
  }, [others, groups, chats, query, nameFor, settings, showArchived]);

  return (
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

      {hits === null && (showArchived || hasArchived) && (
        <button
          type="button"
          className={styles.archivedToggle}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "← Back to chats" : "Archived"}
        </button>
      )}

      <div className={styles.fabWrap}>
        <PaneScroll>
          {hits !== null && (
            <>
              <div className={styles.sectionLabel}>
                {hits.length} message{hits.length === 1 ? "" : "s"}
              </div>
              {hits.map((hit) => (
                <button
                  key={hit.message.id}
                  type="button"
                  className={styles.item}
                  onClick={() => router.push(`/chats/${encodeURIComponent(hit.chatId)}`)}
                >
                  <span className={styles.avatar}>
                    {initialsFor(titleFor(hit.chatId))}
                  </span>
                  <span className={styles.itemBody}>
                    <span className={styles.itemTop}>
                      <span className={styles.itemName}>
                        {titleFor(hit.chatId)}
                      </span>
                      <span className={styles.itemTime}>{timeLabel(hit.message.sentAtMs)}</span>
                    </span>
                    <span className={styles.itemPreview}>{searchableText(hit.message)}</span>
                  </span>
                </button>
              ))}
            </>
          )}

          {rows.length === 0 && hits === null && (
            <PaneEmpty>
              {showArchived ? "Nothing archived." : "No chats yet. Start one to begin."}
            </PaneEmpty>
          )}
          {hits === null && rows.map((row) => (
            <div key={row.email} className={styles.itemRow}>
            <button
              type="button"
              className={styles.item}
              onClick={() => router.push(`/chats/${encodeURIComponent(row.email)}`)}
            >
              <Avatar email={row.email} label={row.name} size={49} className={styles.avatar} />
              <span className={styles.itemBody}>
                <span className={styles.itemTop}>
                  <span className={styles.itemName}>{row.name}</span>
                  {row.summary?.lastMessage && (
                    <span className={styles.itemTime}>{timeLabel(row.summary.lastMessage.sentAtMs)}</span>
                  )}
                </span>
                <span className={styles.itemBottom}>
                  <span className={styles.itemPreview}>
                    {settings[row.email]?.draft
                      ? `Draft: ${settings[row.email].draft}`
                      : preview(row.summary?.lastMessage ?? null)}
                  </span>
                  {settings[row.email]?.pinned && <Icon name="pin" size={13} />}
                  {isMuted(settings[row.email] ?? {}) && <Icon name="micOff" size={13} />}
                  {(row.summary?.unread ?? 0) > 0 && !isMuted(settings[row.email] ?? {}) && (
                    <span className={styles.unread}>{row.summary!.unread}</span>
                  )}
                </span>
              </span>
            </button>

            <button
              type="button"
              className={styles.itemMenuButton}
              aria-label={`Options for ${row.name}`}
              onClick={() => setMenuFor(menuFor === row.email ? null : row.email)}
            >
              <Icon name="chevron" size={16} />
            </button>

            {menuFor === row.email && (
              <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  aria-label="Close menu"
                  onClick={() => setMenuFor(null)}
                />
                <div className={styles.itemMenu} role="menu">
                  <button
                    type="button"
                    className={styles.itemMenuItem}
                    onClick={() => patch(row.email, { pinned: !settings[row.email]?.pinned })}
                  >
                    {settings[row.email]?.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    className={styles.itemMenuItem}
                    onClick={() => patch(row.email, { archived: !settings[row.email]?.archived })}
                  >
                    {settings[row.email]?.archived ? "Unarchive" : "Archive"}
                  </button>
                  {isMuted(settings[row.email] ?? {}) ? (
                    <button
                      type="button"
                      className={styles.itemMenuItem}
                      onClick={() => patch(row.email, { mutedUntilMs: 0 })}
                    >
                      Unmute
                    </button>
                  ) : (
                    MUTE_DURATIONS.map((d) => (
                      <button
                        key={d.label}
                        type="button"
                        className={styles.itemMenuItem}
                        onClick={() =>
                          patch(row.email, {
                            mutedUntilMs: d.ms === Infinity ? Infinity : Date.now() + d.ms,
                          })
                        }
                      >
                        Mute {d.label}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
            </div>
          ))}
        </PaneScroll>

        <button
          className={styles.fab}
          type="button"
          onClick={() => router.push("/chats/new")}
          aria-label="New chat"
        >
          <Icon name="plus" size={24} />
        </button>
      </div>
    </Pane>
  );
}
