"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader, PaneScroll } from "@/components/ui/Pane";
import { clearCallLog, formatDuration, loadCallLog, type CallRecord } from "@/lib/call/call-log";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { getGroup, isGroupId } from "@/lib/groups";

import styles from "../chats/chats.module.css";

function whenLabel(ms: number): string {
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

function outcomeLabel(record: CallRecord): string {
  const direction = record.outgoing ? "Outgoing" : "Incoming";
  if (record.outcome === "missed") return `Missed ${record.video ? "video" : "voice"} call`;
  if (record.outcome === "failed") return `${direction} · not connected`;
  return `${direction} · ${record.durationMs ? formatDuration(record.durationMs) : "0:00"}`;
}

export default function CallsPage() {
  const router = useRouter();
  const { others, nameFor } = useDirectory();
  const [log, setLog] = useState<CallRecord[]>([]);
  const [tab, setTab] = useState<"recent" | "contacts">("recent");

  useEffect(() => setLog(loadCallLog()), []);

  const rows = useMemo(
    () =>
      log.map((record) => ({
        record,
        label: isGroupId(record.chatId)
          ? getGroup(record.chatId)?.name ?? "Group"
          : nameFor(record.chatId),
      })),
    [log, nameFor]
  );

  return (
    <AppShell detail={<PaneEmpty>Start a call from the list.</PaneEmpty>}>
      <Pane>
        <PaneHeader
          title="Calls"
          actions={
            tab === "recent" && log.length > 0 ? (
              <button
                type="button"
                className={styles.archivedToggle}
                style={{ width: "auto", border: "none", padding: "6px 10px" }}
                onClick={() => {
                  clearCallLog();
                  setLog([]);
                }}
              >
                Clear
              </button>
            ) : undefined
          }
        />

        <div className={styles.searchWrap}>
          <div style={{ display: "flex", gap: 8 }}>
            {(["recent", "contacts"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={styles.archivedToggle}
                style={{
                  width: "auto",
                  border: "none",
                  padding: "6px 14px",
                  borderRadius: "var(--radius-pill)",
                  background: tab === t ? "var(--accent-soft)" : "transparent",
                  color: tab === t ? "var(--accent)" : "var(--ink-muted)",
                }}
                aria-current={tab === t ? "page" : undefined}
                onClick={() => setTab(t)}
              >
                {t === "recent" ? "Recent" : "Contacts"}
              </button>
            ))}
          </div>
        </div>

        <PaneScroll>
          {tab === "recent" ? (
            <>
              {rows.length === 0 && <PaneEmpty>No calls yet.</PaneEmpty>}
              {rows.map(({ record, label }) => (
                <div key={record.id} className={styles.item}>
                  <Avatar email={record.chatId} label={label} size={49} className={styles.avatar} />
                  <span className={styles.itemBody}>
                    <span className={styles.itemTop}>
                      <span className={styles.itemName}>{label}</span>
                      <span className={styles.itemTime}>{whenLabel(record.startedAtMs)}</span>
                    </span>
                    <span
                      className={styles.itemPreview}
                      style={record.outcome === "missed" ? { color: "var(--danger)" } : undefined}
                    >
                      {outcomeLabel(record)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Call ${label} back`}
                    onClick={() =>
                      router.push(
                        `/call/${encodeURIComponent(record.chatId)}${record.video ? "?video=1" : ""}`
                      )
                    }
                    style={{ color: "var(--accent)", padding: 8 }}
                  >
                    <Icon name={record.video ? "video" : "phone"} size={20} />
                  </button>
                </div>
              ))}
            </>
          ) : (
            <>
              {others.length === 0 && <PaneEmpty>No other members yet.</PaneEmpty>}
              {others.map((member) => (
                <div key={member.email} className={styles.item}>
                  <Avatar email={member.email} label={nameFor(member.email)} size={49} className={styles.avatar} />
                  <span className={styles.itemBody}>
                    <span className={styles.itemName}>{nameFor(member.email)}</span>
                    <span className={styles.itemPreview}>
                      {member.username ? `@${member.username}` : member.email}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Voice call ${nameFor(member.email)}`}
                    onClick={() => router.push(`/call/${encodeURIComponent(member.email)}`)}
                    style={{ color: "var(--accent)", padding: 8 }}
                  >
                    <Icon name="phone" size={20} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Video call ${nameFor(member.email)}`}
                    onClick={() => router.push(`/call/${encodeURIComponent(member.email)}?video=1`)}
                    style={{ color: "var(--accent)", padding: 8 }}
                  >
                    <Icon name="video" size={21} />
                  </button>
                </div>
              ))}
            </>
          )}
        </PaneScroll>
      </Pane>
    </AppShell>
  );
}
