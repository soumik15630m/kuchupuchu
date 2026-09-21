"use client";

import { useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { loadGroups } from "@/lib/groups";
import type { ChatTarget } from "@/lib/messaging/client";
import type { StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

/** Picks where to forward a message. Kept separate from the chat list so the
 * list's own concerns (archive, pin, unread) stay out of a modal that only
 * needs "which conversation". */
export function ForwardSheet({
  message,
  onPick,
  onClose,
}: {
  message: StoredMessage;
  onPick: (target: ChatTarget, audience: string[]) => void;
  onClose: () => void;
}) {
  const { others, nameFor } = useDirectory();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => loadGroups(), []);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const direct = others.map((m) => ({
      key: m.email,
      label: nameFor(m.email),
      sub: m.username ? `@${m.username}` : m.email,
      target: { kind: "direct", email: m.email } as ChatTarget,
      audience: [m.email],
    }));
    const grouped = groups.map((g) => ({
      key: g.id,
      label: g.name,
      sub: `${g.members.length} members`,
      target: { kind: "group", group: g } as ChatTarget,
      audience: g.members,
    }));
    const all = [...grouped, ...direct];
    return q ? all.filter((o) => o.label.toLowerCase().includes(q) || o.sub.toLowerCase().includes(q)) : all;
  }, [others, groups, query, nameFor]);

  return (
    <>
      <button type="button" className={styles.menuBackdrop} aria-label="Close" onClick={onClose} />
      <div className={styles.forwardSheet} role="dialog" aria-label="Forward to">
        <div className={styles.forwardHeader}>
          <strong>Forward to</strong>
          <button type="button" className={styles.emojiClose} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.gifSearch}>
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search conversations"
          />
        </div>

        <div className={styles.forwardList}>
          {options.length === 0 && <p className={styles.pickerNote}>Nothing matches.</p>}
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className={styles.forwardOption}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onPick(option.target, option.audience);
              }}
            >
              <span className={styles.forwardAvatar}>{initialsFor(option.label)}</span>
              <span>
                <span className={styles.forwardName}>{option.label}</span>
                <span className={styles.forwardSub}>{option.sub}</span>
              </span>
            </button>
          ))}
        </div>

        {message.media && (
          <p className={styles.pickerNote}>
            The attachment is re-uploaded for the new recipients, since the original was only
            readable by this chat.
          </p>
        )}
      </div>
    </>
  );
}
