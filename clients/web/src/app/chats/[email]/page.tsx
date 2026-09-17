"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { Composer } from "@/components/chat/Composer";
import { MessageBubble } from "@/components/chat/MessageBubble";
import styles from "@/components/chat/chat.module.css";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, paneStyles } from "@/components/ui/Pane";
import { displayName, loadContacts } from "@/lib/contacts";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { messagesFor, type StoredMessage } from "@/lib/messaging/store";
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
  const email = decodeURIComponent(params.email);
  const { wallpaperFor } = useTheme();
  const { client, revision, typingFrom, online, ready } = useMessaging();

  const [name, setName] = useState(email);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const wp = wallpaperFor(email);

  useEffect(() => setName(displayName(email, loadContacts())), [email]);

  useEffect(() => {
    let cancelled = false;
    messagesFor(email).then((loaded) => {
      if (!cancelled) setMessages(loaded.sort((a, b) => a.sentAtMs - b.sentAtMs));
    });
    return () => {
      cancelled = true;
    };
  }, [email, revision]);

  // Opening a chat is what marks its incoming messages read.
  useEffect(() => {
    if (!client) return;
    const unread = messages.filter((m) => !m.outgoing && m.status !== "read").map((m) => m.id);
    if (unread.length > 0) void client.markRead(email, unread);
  }, [client, email, messages]);

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

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typingFrom]);

  const style = wallpaperStyle(wp, imageUrl);
  let lastDay = "";

  return (
    <AppShell pane="detail">
      <Pane>
        <PaneHeader
          title={name}
          subtitle={typingFrom === email ? "typing…" : email}
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
              {messages.map((message) => {
                const day = dayLabel(message.sentAtMs);
                const separator = day !== lastDay ? day : null;
                lastDay = day;
                return (
                  <div key={message.id} style={{ display: "contents" }}>
                    {separator && <span className={styles.daySeparator}>{separator}</span>}
                    <MessageBubble
                      message={message}
                      onReply={setReplyTo}
                      onReact={(target, emoji) => void client?.react(email, target.id, emoji)}
                      onDelete={(target) => void client?.deleteForEveryone(email, target.id)}
                    />
                  </div>
                );
              })}
              {typingFrom === email && (
                <div className={styles.typing} aria-label={`${name} is typing`}>
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                </div>
              )}
            </div>
          </div>

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
                <Icon name="plus" size={18} />
              </button>
            </div>
          )}

          <Composer peerEmail={email} replyTo={replyTo} onReplyConsumed={() => setReplyTo(null)} />
        </div>
      </Pane>
    </AppShell>
  );
}
