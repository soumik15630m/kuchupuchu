"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { deviceId } from "../api/client";
import { useSession } from "../auth/SessionProvider";
import { useDirectory } from "../directory/DirectoryProvider";
import { notifyMessage, setBadge } from "../notifications";
import { MessagingClient } from "./client";
import { summaries, type ChatSummary, type StoredMessage } from "./store";
import { statusReels, type StatusReel } from "./status-store";
import { applyTyping, emptyTyping, pruneTyping, TYPING_EXPIRY_MS, type TypingState } from "./typing.mjs";

interface MessagingContextValue {
  client: MessagingClient | null;
  online: boolean;
  ready: boolean;
  chats: Map<string, ChatSummary>;
  /** Who is typing, per conversation, with per-entry expiry. A single global
   * value could only ever be right for one chat, and never matched a group. */
  typing: TypingState;
  statuses: StatusReel[];
  /** Bumped on every change so chat views can re-read their own slice
   * without every message landing in a single shared array. */
  revision: number;
  refreshChats: () => void;
  refreshStatuses: () => void;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const { status, session } = useSession();
  const { nameFor } = useDirectory();
  // Held in a ref, not a dependency: the messaging client owns the WebSocket
  // and every ratchet session, so rebuilding it whenever a display name
  // changes would drop the connection and re-derive crypto state for a
  // cosmetic update.
  const nameForRef = useRef(nameFor);
  nameForRef.current = nameFor;
  const clientRef = useRef<MessagingClient | null>(null);
  const [online, setOnline] = useState(false);
  const [ready, setReady] = useState(false);
  const [chats, setChats] = useState<Map<string, ChatSummary>>(new Map());
  const [revision, setRevision] = useState(0);
  const [typing, setTyping] = useState<TypingState>(emptyTyping);
  const [statuses, setStatuses] = useState<StatusReel[]>([]);
  // Entries carry their own expiry, so a single sweep replaces the per-sender
  // timers this used to juggle.
  const typingSweep = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshChats = useCallback(() => {
    summaries()
      .then((next) => {
        setChats(next);
        let unread = 0;
        for (const summary of next.values()) unread += summary.unread;
        setBadge(unread);
      })
      .catch(() => {});
  }, []);

  const refreshStatuses = useCallback(() => {
    statusReels()
      .then(setStatuses)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || !session) return;

    const bump = () => {
      setRevision((n) => n + 1);
      refreshChats();
    };

    const client = new MessagingClient(session, deviceId(), {
      onMessage: (message) => {
        notifyMessage(message, nameForRef.current(message.chatId));
        bump();
      },
      onStatus: bump,
      onStatusPost: refreshStatuses,
      onOutboxDrained: bump,
      onConnectionChange: setOnline,
      onTyping: (event) => setTyping((prev) => applyTyping(prev, event, Date.now())),
    });
    clientRef.current = client;

    client
      .start()
      .then(() => setReady(true))
      .catch((err) => {
        console.warn("messaging: could not start", err);
        setReady(true);
      });
    refreshChats();
    refreshStatuses();

    // A peer that closes the tab mid-typing never sends the stop, so entries
    // have to lapse on their own.
    typingSweep.current = setInterval(
      () => setTyping((prev) => pruneTyping(prev, Date.now())),
      TYPING_EXPIRY_MS / 2
    );

    return () => {
      client.stop();
      clientRef.current = null;
      setReady(false);
      setOnline(false);
      if (typingSweep.current) clearInterval(typingSweep.current);
      typingSweep.current = null;
      setTyping(emptyTyping());
    };
  }, [status, session, refreshChats, refreshStatuses]);

  const value = useMemo<MessagingContextValue>(
    () => ({
      client: clientRef.current,
      online,
      ready,
      chats,
      typing,
      statuses,
      revision,
      refreshChats,
      refreshStatuses,
    }),
    [online, ready, chats, typing, statuses, revision, refreshChats, refreshStatuses]
  );

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

export function useMessaging(): MessagingContextValue {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used inside MessagingProvider");
  return ctx;
}

export type { StoredMessage };
