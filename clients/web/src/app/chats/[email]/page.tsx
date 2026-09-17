"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneHeader, paneStyles } from "@/components/ui/Pane";
import { displayName, loadContacts } from "@/lib/contacts";
import { appendMessage, formatTime, loadMessages, type Message } from "@/lib/messages";
import { wallpaperStyle } from "@/lib/theme/apply";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { getWallpaper } from "@/lib/theme/wallpaper-store";

import styles from "./chat.module.css";

export default function ChatPage() {
  const params = useParams<{ email: string }>();
  const router = useRouter();
  const email = decodeURIComponent(params.email);
  const { wallpaperFor } = useTheme();

  const [name, setName] = useState(email);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const wp = wallpaperFor(email);

  useEffect(() => {
    setName(displayName(email, loadContacts()));
    setMessages(loadMessages(email));
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

  useLayoutEffect(() => {
    const el = streamRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    setMessages((prev) => [...prev, appendMessage(email, body, true)]);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line — but only where there is a
    // keyboard to hold Shift on. On a touch keyboard Enter must insert a
    // newline, since there is no other way to type one.
    if (e.key !== "Enter" || e.shiftKey) return;
    if (matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    send();
  }

  const style = wallpaperStyle(wp, imageUrl);

  return (
    <AppShell
      pane="detail"
      detail={
        <Pane>
          <PaneHeader
            title={name}
            subtitle={email}
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
              </>
            }
          />

          <div className={styles.chat}>
            <div
              className={styles.canvas}
              style={{
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                backgroundSize: style.backgroundSize,
              }}
            >
              {style.dim > 0 && <span className={styles.scrim} style={{ opacity: style.dim }} />}
              <div className={styles.stream} ref={streamRef}>
                {messages.length === 0 && (
                  <p className={styles.empty}>No messages yet — this chat is stored on this device.</p>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`${styles.bubble} ${m.outgoing ? styles.out : styles.in}`}>
                    {m.body}
                    <span className={styles.meta}>{formatTime(m.sentAtMs)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.composer}>
              <div className={styles.field}>
                <span className={styles.composerIcon}>
                  <Icon name="emoji" size={21} />
                </span>
                <textarea
                  ref={inputRef}
                  className={styles.input}
                  rows={1}
                  value={draft}
                  placeholder="Message"
                  aria-label="Message"
                  onKeyDown={onKeyDown}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                  }}
                />
                <span className={styles.composerIcon}>
                  <Icon name="attach" size={20} />
                </span>
              </div>
              <button
                className={styles.send}
                type="button"
                aria-label={draft.trim() ? "Send" : "Record voice note"}
                onClick={send}
              >
                <Icon name={draft.trim() ? "send" : "mic"} size={20} />
              </button>
            </div>
          </div>
        </Pane>
      }
    >
      {null}
    </AppShell>
  );
}
