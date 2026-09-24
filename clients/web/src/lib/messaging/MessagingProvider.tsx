"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { deviceId } from "../api/client";
import { useSession } from "../auth/SessionProvider";
import { useDirectory } from "../directory/DirectoryProvider";
import { notifyMessage, setBadge } from "../notifications";
import { MessagingClient } from "./client";
import { summaries, type ChatSummary, type StoredMessage } from "./store";
import { statusReels, type StatusReel } from "./status-store";
import { isMuted, settingsFor } from "./chat-settings";
import { announceSyncedTheme, coerceTheme } from "../theme/storage";
import { mentionedEmails } from "./formatting.mjs";
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
  /** Bumped when a peer's avatar changes, so avatars re-read without the
   * whole chat list re-rendering on every incoming message. */
  profileRevision: number;
  refreshChats: () => void;
  refreshStatuses: () => void;
}

const MessagingContext = createContext<MessagingContextValue | null>(null);

/** Whether an incoming message @-mentions the signed-in member.
 *
 * `mentionedEmails` was implemented and unit-tested and then referenced by
 * nothing, so being mentioned produced no notification, no badge and no
 * override of a muted group. */
function mentionsMe(
  message: StoredMessage,
  members: { email: string; username: string | null }[],
  myEmail: string | null
): boolean {
  if (!myEmail || message.outgoing || !message.body) return false;
  const mentionables = new Map<string, string>();
  for (const member of members) {
    if (member.username) mentionables.set(member.username.toLowerCase(), member.email);
  }
  return mentionedEmails(message.body, mentionables).some(
    (e) => e.toLowerCase() === myEmail.toLowerCase()
  );
}

export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const { status, session, email } = useSession();
  const { nameFor, members } = useDirectory();
  // Held in a ref, not a dependency: the messaging client owns the WebSocket
  // and every ratchet session, so rebuilding it whenever a display name
  // changes would drop the connection and re-derive crypto state for a
  // cosmetic update.
  const nameForRef = useRef(nameFor);
  nameForRef.current = nameFor;
  // Same reason as nameFor: the directory changes far more often than the
  // messaging client should be rebuilt.
  const membersRef = useRef(members);
  membersRef.current = members;
  const myEmailRef = useRef(email);
  myEmailRef.current = email;
  const clientRef = useRef<MessagingClient | null>(null);
  const [online, setOnline] = useState(false);
  const [ready, setReady] = useState(false);
  const [chats, setChats] = useState<Map<string, ChatSummary>>(new Map());
  const [revision, setRevision] = useState(0);
  const [profileRevision, setProfileRevision] = useState(0);
  const [typing, setTyping] = useState<TypingState>(emptyTyping);
  const [statuses, setStatuses] = useState<StatusReel[]>([]);
  // Entries carry their own expiry, so a single sweep replaces the per-sender
  // timers this used to juggle.
  const typingSweep = useRef<ReturnType<typeof setInterval> | null>(null);

  // Coalesced: rebuilding the chat list reads every stored message, and a
  // single group send produces a delivered and a read receipt per recipient.
  // Without this, one message meant ten full rebuilds in a group of five.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshChats = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      summaries()
        .then((next) => {
          setChats(next);
          // Muted and archived chats are excluded: the in-app pill already
          // hides them, and an OS badge that disagrees with the list is worse
          // than no badge. This was the other half of mute being cosmetic.
          let unread = 0;
          for (const summary of next.values()) {
            const chat = settingsFor(summary.chatId);
            if (chat.archived || isMuted(chat)) continue;
            unread += summary.unread;
          }
          setBadge(unread);
        })
        .catch(() => {});
    }, 120);
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
        notifyMessage(message, nameForRef.current(message.chatId), {
          mentionsYou: mentionsMe(message, membersRef.current, myEmailRef.current),
        });
        bump();
      },
      onStatus: bump,
      onStatusPost: refreshStatuses,
      onOutboxDrained: bump,
      onConnectionChange: setOnline,
      onTyping: (event) => setTyping((prev) => applyTyping(prev, event, Date.now())),
      onProfileChanged: () => setProfileRevision((n) => n + 1),
      onThemeReceived: (incoming) => announceSyncedTheme(coerceTheme(incoming)),
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
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
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
      profileRevision,
      refreshChats,
      refreshStatuses,
    }),
    [online, ready, chats, typing, statuses, revision, profileRevision, refreshChats, refreshStatuses]
  );

  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>;
}

export function useMessaging(): MessagingContextValue {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used inside MessagingProvider");
  return ctx;
}

export type { StoredMessage };
