"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { Composer } from "@/components/chat/Composer";
import { ForwardSheet } from "@/components/chat/ForwardSheet";
import { MessageBubble } from "@/components/chat/MessageBubble";
import styles from "@/components/chat/chat.module.css";

/** Messages rendered at once. Enough to fill any screen and scroll a little,
 * small enough that opening a long chat is instant. */
const PAGE_SIZE = 60;
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, paneStyles } from "@/components/ui/Pane";
import { initialsFor, useDirectory } from "@/lib/directory/DirectoryProvider";
import { settingsFor, updateChatSettings } from "@/lib/messaging/chat-settings";
import { loadSharing, shouldShowTyping } from "@/lib/messaging/privacy.mjs";
import { typingLabel, typistsIn } from "@/lib/messaging/typing.mjs";
import { useChatTarget } from "@/lib/messaging/useChatTarget";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { deleteMessage, messagesFor, setStarred, type StoredMessage } from "@/lib/messaging/store";
import { wallpaperStyle } from "@/lib/theme/apply";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { getWallpaper } from "@/lib/theme/wallpaper-store";

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(date, today)) return "Today";
  if (same(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

export default function ChatPage() {
  const params = useParams<{ email: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const email = decodeURIComponent(params.email);
  const { wallpaperFor } = useTheme();
  const { nameFor, members } = useDirectory();
  const { client, revision, typing: typingState, online, ready, refreshChats } = useMessaging();

  const chat = useChatTarget(email, revision);
  const name = chat.title;
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [editing, setEditing] = useState<StoredMessage | null>(null);
  const [forwarding, setForwarding] = useState<StoredMessage | null>(null);
  const [sharingContact, setSharingContact] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Only people actually in this conversation can be mentioned.
  const mentionables = useMemo(() => {
    const scope = chat.group ? new Set(chat.group.members) : new Set([email]);
    const map = new Map<string, string>();
    for (const member of members) {
      if (member.username && scope.has(member.email)) map.set(member.username.toLowerCase(), member.email);
    }
    return map;
  }, [members, chat.group, email]);

  const wp = wallpaperFor(email);
  // Reciprocal, like read receipts: someone who hides their own typing does
  // not get to watch everyone else's.
  const typing = shouldShowTyping(loadSharing())
    ? typistsIn(typingState, email, Date.now())
    : [];

  useEffect(() => {
    let cancelled = false;
    messagesFor(email).then((loaded) => {
      if (!cancelled) setMessages(loaded.sort((a, b) => a.sentAtMs - b.sentAtMs));
    });
    return () => {
      cancelled = true;
    };
  }, [email, revision]);

  // Opening a chat marks its incoming messages read -- but only while the tab
  // is actually in front. A chat left open in a background tab was reporting
  // read receipts for messages nobody had looked at.
  useEffect(() => {
    if (!client) return;
    const markVisible = () => {
      if (document.visibilityState !== "visible") return;
      const unread = messages.filter((m) => !m.outgoing && m.status !== "read").map((m) => m.id);
      if (unread.length > 0) void client.markRead(email, unread);
    };
    markVisible();
    document.addEventListener("visibilitychange", markVisible);
    return () => document.removeEventListener("visibilitychange", markVisible);
  }, [client, email, messages]);

  // Opening the chat is what clears a manual "mark as unread".
  useEffect(() => {
    if (settingsFor(email).unreadMark) updateChatSettings(email, { unreadMark: false });
  }, [email]);


  useEffect(() => {
    if (wp.kind !== "image") {
      setImageUrl(undefined);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    getWallpaper(wp.value).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setImageUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [wp.kind, wp.value]);

  // Follow new messages only while already at the bottom. Scrolling on every
  // change yanked the view away mid-sentence whenever anything arrived while
  // reading history.
  const atBottomRef = useRef(true);
  const [newBelow, setNewBelow] = useState(0);
  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const lastCountRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = canvasRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setNewBelow(0);
  }, []);

  useLayoutEffect(() => {
    const grew = messages.length - lastCountRef.current;
    lastCountRef.current = messages.length;

    if (atBottomRef.current) {
      const el = canvasRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setNewBelow(0);
      return;
    }
    // Only incoming messages are worth a pill; sending one always jumps.
    if (grew > 0) {
      const added = messages.slice(-grew);
      const incoming = added.filter((m) => !m.outgoing).length;
      if (incoming > 0) setNewBelow((n) => n + incoming);
      if (added.some((m) => m.outgoing)) scrollToBottom();
    }
  }, [messages, typing, scrollToBottom]);

  // Jumping to the bottom when the chat changes is always right.
  useLayoutEffect(() => {
    atBottomRef.current = true;
    lastCountRef.current = 0;
    setNewBelow(0);
    setWindowSize(PAGE_SIZE);
  }, [email]);

  // Only the tail is rendered. A long history was mounting every bubble it
  // had ever seen, which is thousands of DOM nodes and every thumbnail
  // decoded, for a screen that shows a dozen.
  const windowed = useMemo(
    () => (messages.length > windowSize ? messages.slice(-windowSize) : messages),
    [messages, windowSize]
  );

  // Where the reader left off. Computed from the full list so it is right
  // even when the message sits above the current window.
  const firstUnreadId = useMemo(() => {
    const first = messages.find((m) => !m.outgoing && m.status !== "read");
    return first && first.id !== messages[0]?.id ? first.id : null;
  }, [messages]);

  /** Scrolls a quoted message into view and flashes it. Reply quotes were a
   * dead <span> before, so there was no way back to what was replied to. */
  const jumpTo = useCallback(
    (id: string) => {
      const index = messages.findIndex((m) => m.id === id);
      if (index === -1) return;
      // The target may be older than the rendered window, so widen first and
      // scroll in the effect below -- after React has actually committed the
      // larger window. Doing it in a rAF looked right and silently did
      // nothing, because the anchor did not exist yet.
      const fromEnd = messages.length - index;
      if (fromEnd > windowSize) setWindowSize(fromEnd + 10);
      // Jumping is a deliberate departure from the bottom. Without this the
      // follow-new-messages effect fires when the window grows and snaps
      // straight back, so the target flashed somewhere off screen.
      atBottomRef.current = false;
      setPendingJump(id);
    },
    [messages, windowSize]
  );

  useEffect(() => {
    if (!pendingJump) return;
    const el = document.getElementById(`msg-${pendingJump}`);
    if (!el) return;
    setPendingJump(null);
    // Instant, not smooth: a smooth scroll fires onScroll on the way past the
    // bottom, which flipped the follow-new-messages flag back on mid-flight
    // and snapped the view straight back. A jump is a teleport anyway.
    el.scrollIntoView({ block: "center" });
    atBottomRef.current = false;
    el.dataset.flash = "true";
    const handle = setTimeout(() => delete el.dataset.flash, 1200);
    return () => clearTimeout(handle);
  }, [pendingJump, windowed]);

// A search hit links straight to its message rather than just the chat.
  const jumpTarget = search.get("m");
  useEffect(() => {
    if (jumpTarget && messages.length > 0) jumpTo(jumpTarget);
  }, [jumpTarget, messages.length, jumpTo]);

  const style = wallpaperStyle(wp, imageUrl);
  let lastDay = "";

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader
          title={name}
          subtitle={typingLabel(typing.map(nameFor), Boolean(chat.group)) ?? chat.subtitle}
          backHref="/chats"
          actions={
            <>
              <button
                className={paneStyles.iconButton}
                type="button"
                aria-label="Video call"
                onClick={() => router.push(`/call/${encodeURIComponent(email)}?video=1`)}
              >
                <Icon name="video" size={21} />
              </button>
              <button
                className={paneStyles.iconButton}
                type="button"
                aria-label="Voice call"
                onClick={() => router.push(`/call/${encodeURIComponent(email)}`)}
              >
                <Icon name="phone" size={20} />
              </button>
              <button
                className={paneStyles.iconButton}
                type="button"
                aria-label="Chat settings"
                onClick={() => router.push(`/chats/${encodeURIComponent(email)}/settings`)}
              >
                <Icon name="settings" size={20} />
              </button>
            </>
          }
        />

        {ready && !online && <div className={styles.offline}>Offline — messages will send when reconnected</div>}

        <div className={styles.chat}>
          <div
            ref={canvasRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              // A few pixels of slack: fractional scroll heights mean an
              // exact comparison is never true on a zoomed or scaled display.
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              if (atBottomRef.current) setNewBelow(0);
            }}
            className={styles.canvas}
            style={{
              backgroundColor: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              backgroundSize: style.backgroundSize,
            }}
          >
            {style.dim > 0 && <span className={styles.scrim} style={{ opacity: style.dim }} />}
            <div className={styles.stream}>
              {messages.length === 0 && (
                <p className={styles.empty}>
                  No messages yet. Everything here is end-to-end encrypted.
                </p>
              )}
              {windowed.length < messages.length && (
                <button
                  type="button"
                  className={styles.loadEarlier}
                  onClick={() => setWindowSize((n) => n + PAGE_SIZE)}
                >
                  Load earlier messages
                </button>
              )}
              {windowed.map((message) => {
                const day = dayLabel(message.sentAtMs);
                const separator = day !== lastDay ? day : null;
                lastDay = day;
                const showUnreadMark = message.id === firstUnreadId;
                return (
                  <div key={message.id} style={{ display: "contents" }}>
                    {separator && <span className={styles.daySeparator}>{separator}</span>}
                    {showUnreadMark && (
                      <span className={styles.unreadMark}>Unread messages</span>
                    )}
                    <MessageBubble
                      onJumpTo={jumpTo}
                      message={message}
                      mentionables={mentionables}
                      onReply={setReplyTo}
                      onReact={(msg, emoji) => chat.target && void client?.react(chat.target, msg.id, emoji)}
                      onDelete={(msg) => chat.target && void client?.deleteForEveryone(chat.target, msg.id)}
                      onDeleteForMe={async (msg) => {
                        await deleteMessage(msg.id);
                        refreshChats();
                        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
                      }}
                      onViewOnceOpened={(msg) =>
                        chat.target && void client?.markViewOnceOpened(chat.target, msg)
                      }
                      onRetry={() => void client?.retryOutbox()}
                      onEdit={setEditing}
                      onForward={setForwarding}
                      onStar={async (msg) => {
                        const updated = await setStarred(msg.id, !msg.starred);
                        if (updated) setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
                      }}
                    />
                  </div>
                );
              })}
              {typing.length > 0 && (
                <div
                  className={styles.typing}
                  aria-label={typingLabel(typing.map(nameFor), Boolean(chat.group)) ?? "typing"}
                >
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                </div>
              )}
            </div>
          </div>

          {newBelow > 0 && (
            <button
              type="button"
              className={styles.newBelow}
              onClick={() => scrollToBottom("smooth")}
            >
              {newBelow} new message{newBelow === 1 ? "" : "s"} ↓
            </button>
          )}

          {replyTo && (
            <div className={styles.replyBar}>
              <span className={styles.replyBarBody}>
                <span className={styles.replyBarWho}>
                  {replyTo.outgoing ? "You" : name}
                </span>
                <span className={styles.replyBarText}>
                  {replyTo.body || (replyTo.kind === "voice" ? "Voice note" : "Attachment")}
                </span>
              </span>
              <button
                type="button"
                className={paneStyles.iconButton}
                aria-label="Cancel reply"
                onClick={() => setReplyTo(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          )}

          {chat.target ? (
            <Composer
              target={chat.target}
              audience={chat.audience}
              replyTo={replyTo}
              onReplyConsumed={() => setReplyTo(null)}
              editing={editing}
              onEditDone={() => setEditing(null)}
              mentionables={mentionables}
              onShareContact={() => setSharingContact(true)}
            />
          ) : (
            <p className={styles.composerError}>This group is no longer on this device.</p>
          )}
        </div>

        {sharingContact && (
          <>
            <button
              type="button"
              className={styles.menuBackdrop}
              aria-label="Close"
              onClick={() => setSharingContact(false)}
            />
            <div className={styles.forwardSheet} role="dialog" aria-label="Share a contact">
              <div className={styles.forwardHeader}>
                <strong>Share a contact</strong>
                <button
                  type="button"
                  className={styles.emojiClose}
                  onClick={() => setSharingContact(false)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <div className={styles.forwardList}>
                {members.map((member) => (
                  <button
                    key={member.email}
                    type="button"
                    className={styles.forwardOption}
                    onClick={async () => {
                      setSharingContact(false);
                      if (!chat.target) return;
                      await client?.sendContact(chat.target, {
                        email: member.email,
                        username: member.username,
                        displayName: member.displayName,
                      });
                    }}
                  >
                    <span className={styles.forwardAvatar}>{initialsFor(nameFor(member.email))}</span>
                    <span>
                      <span className={styles.forwardName}>{nameFor(member.email)}</span>
                      <span className={styles.forwardSub}>
                        {member.username ? `@${member.username}` : member.email}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {forwarding && (
          <ForwardSheet
            message={forwarding}
            onClose={() => setForwarding(null)}
            onPick={async (target, audience) => {
              const message = forwarding;
              setForwarding(null);
              try {
                await client?.forward(target, message, audience);
                refreshChats();
              } catch {
                // Surfaced by the destination chat showing nothing new; a
                // failed forward leaves the original untouched.
              }
            }}
          />
        )}
      </Pane>
    </AppShell>
  );
}
