"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { deviceId } from "../api/client";
import { useSession } from "../auth/SessionProvider";
import { displayName, loadContacts } from "../contacts";
import { notifyMessage, setBadge } from "../notifications";
import { MessagingClient } from "./client";
import { summaries, type ChatSummary, type StoredMessage } from "./store";

interface MessagingContextValue {
  client: MessagingClient | null;
  online: boolean;
  ready: boolean;
  chats: Map<string, ChatSummary>;
  typingFrom: string | null;
  /** Bumped on every change so chat views can re-read their own slice
   * without every message landing in a single shared array. */
  revision: number;
  refreshChats: () => void;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const { status, session } = useSession();
  const clientRef = useRef<MessagingClient | null>(null);
  const [online, setOnline] = useState(false);
  const [ready, setReady] = useState(false);
  const [chats, setChats] = useState<Map<string, ChatSummary>>(new Map());
  const [revision, setRevision] = useState(0);
  const [typingFrom, setTypingFrom] = useState<string | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (status !== "authenticated" || !session) return;

    const bump = () => {
      setRevision((n) => n + 1);
      refreshChats();
    };

    const client = new MessagingClient(session, deviceId(), {
      onMessage: (message) => {
        notifyMessage(message, displayName(message.chatId, loadContacts()));
        bump();
      },
      onStatus: bump,
      onConnectionChange: setOnline,
      onTyping: ({ fromEmail, stopped }) => {
        if (typingTimer.current) clearTimeout(typingTimer.current);
        if (stopped) {
          setTypingFrom(null);
          return;
        }
        setTypingFrom(fromEmail);
        // A peer that closes the tab mid-typing never sends the stop, so the
        // indicator has to expire on its own.
        typingTimer.current = setTimeout(() => setTypingFrom(null), 5000);
      },
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

    return () => {
      client.stop();
      clientRef.current = null;
      setReady(false);
      setOnline(false);
    };
  }, [status, session, refreshChats]);

  const value = useMemo<MessagingContextValue>(
    () => ({ client: clientRef.current, online, ready, chats, typingFrom, revision, refreshChats }),
    [online, ready, chats, typingFrom, revision, refreshChats]
  );

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

export function useMessaging(): MessagingContextValue {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used inside MessagingProvider");
  return ctx;
}

export type { StoredMessage };
