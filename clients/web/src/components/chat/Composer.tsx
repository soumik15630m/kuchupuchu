"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { CameraSheet } from "@/components/chat/CameraSheet";
import { EmojiPicker } from "@/components/chat/EmojiPicker";
import { MediaEditor } from "@/components/chat/MediaEditor";
import { GifStickerPicker } from "@/components/chat/GifStickerPicker";
import { downloadGif, type Gif } from "@/lib/messaging/gifs";
import type { Sticker } from "@/lib/messaging/stickers";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { compressImage, makeThumbnail, pickVoiceMimeType, videoPoster } from "@/lib/messaging/media";
import { targetChatId, type ChatTarget } from "@/lib/messaging/client";
import { settingsFor, updateChatSettings } from "@/lib/messaging/chat-settings";
import type { ReplyRef, StoredMessage } from "@/lib/messaging/store";

import styles from "./chat.module.css";

export function Composer({
  target,
  audience,
  replyTo,
  onReplyConsumed,
  editing,
  onEditDone,
  mentionables,
  onShareContact,
}: {
  target: ChatTarget;
  audience: string[];
  replyTo?: StoredMessage | null;
  onReplyConsumed?: () => void;
  editing?: StoredMessage | null;
  onEditDone?: () => void;
  /** username (lowercase) -> email, for the @ autocomplete. */
  mentionables?: Map<string, string>;
  /** Opens the member picker; the chat page owns it since it needs the
   * directory and a sheet of its own. */
  onShareContact?: () => void;
}) {
  const { client } = useMessaging();
  const chatId = targetChatId(target);
  const [draft, setDraft] = useState(() => settingsFor(chatId).draft ?? "");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every picked or captured image passes through the editor first; sending
  // straight through would make crop and draw a separate, easily-missed path.
  const [editingPhoto, setEditingPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGifs, setShowGifs] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedMs, setRecordedMs] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Switching chats swaps the draft rather than carrying text across.
  useEffect(() => {
    setDraft(settingsFor(chatId).draft ?? "");
  }, [chatId]);

  useEffect(() => {
    if (editing) setDraft(editing.body);
  }, [editing]);

  // Persisted on a debounce: a draft that only survives if you navigate away
  // slowly is not a draft.
  useEffect(() => {
    const handle = setTimeout(() => updateChatSettings(chatId, { draft }), 400);
    return () => clearTimeout(handle);
  }, [chatId, draft]);

  function replyRef(): ReplyRef | undefined {
    if (!replyTo) return undefined;
    return {
      id: replyTo.id,
      body: replyTo.body || (replyTo.kind === "voice" ? "Voice note" : "Attachment"),
      fromEmail: replyTo.fromEmail,
    };
  }

  async function sendText() {
    const body = draft.trim();
    if (!body || !client) return;

    if (editing) {
      setDraft("");
      onEditDone?.();
      updateChatSettings(chatId, { draft: "" });
      try {
        await client.edit(target, editing.id, body);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't edit that.");
      }
      return;
    }

    const quoted = replyRef();
    setDraft("");
    setError(null);
    onReplyConsumed?.();
    updateChatSettings(chatId, { draft: "" });
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      await client.sendTyping(target, true);
      await client.send(target, { kind: "text", body, replyTo: quoted });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that.");
    }
  }

  async function sendAttachment(file: File, captionOverride?: string) {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const isVideo = file.type.startsWith("video/");
      const isImage = file.type.startsWith("image/");
      // Anything that is not an image or video is a document: no compression,
      // no thumbnail, and a card rather than a preview.
      const isDocument = !isVideo && !isImage;
      let blob: Blob = file;
      let width: number | undefined;
      let height: number | undefined;
      let thumb: string | undefined;
      let durationMs: number | undefined;

      if (isImage) {
        const compressed = await compressImage(file);
        blob = compressed.blob;
        width = compressed.width;
        height = compressed.height;
        thumb = await makeThumbnail(blob);
      } else if (isVideo) {
        const poster = await videoPoster(file);
        thumb = poster.thumb;
        durationMs = poster.durationMs;
      }

      const quoted = replyRef();
      const caption = captionOverride ?? draft.trim();
      onReplyConsumed?.();
      setDraft("");
      updateChatSettings(chatId, { draft: "" });
      const { mediaId, key, iv } = await client.uploadMedia(audience, blob);
      await client.send(target, {
        kind: isDocument ? "file" : "media",
        body: caption,
        replyTo: quoted,
        media: {
          mediaId,
          key,
          iv,
          mime: blob.type || file.type || "application/octet-stream",
          name: file.name,
          byteSize: blob.size,
          width,
          height,
          thumb,
          durationMs,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that file.");
    } finally {
      setBusy(false);
    }
  }

  /** Both arrive as a blob and go out through the ordinary encrypted media
   * pipeline, so the recipient fetches ciphertext from our own store rather
   * than a third-party URL. */
  async function sendBlobAs(
    blob: Blob,
    kind: "media" | "sticker",
    extras: { name?: string; width?: number; height?: number } = {}
  ) {
    if (!client) return;
    setBusy(true);
    setError(null);
    setShowGifs(false);
    try {
      const thumb = kind === "media" ? await makeThumbnail(blob) : undefined;
      const { mediaId, key, iv } = await client.uploadMedia(audience, blob);
      await client.send(target, {
        kind,
        body: "",
        media: {
          mediaId,
          key,
          iv,
          mime: blob.type || "application/octet-stream",
          byteSize: blob.size,
          thumb,
          ...extras,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that.");
    } finally {
      setBusy(false);
    }
  }

  async function sendGif(gif: Gif) {
    setBusy(true);
    try {
      const blob = await downloadGif(gif);
      await sendBlobAs(blob, "media", {
        name: gif.description,
        width: gif.width,
        height: gif.height,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't fetch that GIF.");
      setBusy(false);
    }
  }

  async function shareLocation() {
    if (!client) return;
    if (!navigator.geolocation) {
      setError("This browser cannot share a location.");
      return;
    }
    setShowAttach(false);
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await client.sendLocation(target, {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracyM: position.coords.accuracy,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't share your location.");
        } finally {
          setBusy(false);
        }
      },
      () => {
        setError("Location permission is needed to share where you are.");
        setBusy(false);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function startRecording() {
    if (!client || recording) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission is needed for voice notes.");
      return;
    }

    const mimeType = pickVoiceMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    chunksRef.current = [];
    cancelledRef.current = false;
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (tickRef.current) clearInterval(tickRef.current);
      setRecording(false);
      setRecordedMs(0);

      const durationMs = Date.now() - startedAtRef.current;
      // Anything this short is a mis-tap, not a voice note.
      if (cancelledRef.current || durationMs < 500) return;

      const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
      setBusy(true);
      try {
        const { mediaId, key, iv } = await client.uploadMedia(audience, blob);
        await client.send(target, {
          kind: "voice",
          body: "",
          media: { mediaId, key, iv, mime: blob.type, byteSize: blob.size, durationMs },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't send the voice note.");
      } finally {
        setBusy(false);
      }
    };

    recorder.start();
    setRecording(true);
    tickRef.current = setInterval(() => setRecordedMs(Date.now() - startedAtRef.current), 200);
  }

  function stopRecording(cancel = false) {
    cancelledRef.current = cancel;
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends only where there is a keyboard to hold Shift on. On a touch
    // keyboard Enter must insert a newline; there is no other way to type one.
    if (e.key !== "Enter" || e.shiftKey) return;
    if (matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    void sendText();
  }

  const hasDraft = draft.trim().length > 0;

  /** Handles matching whatever follows the "@" the caret sits after. */
  const mentionMatches =
    mentionQuery === null || !mentionables
      ? []
      : [...mentionables.keys()]
          .filter((handle) => handle.startsWith(mentionQuery.toLowerCase()))
          .slice(0, 6);

  function updateMentionQuery(value: string, caret: number) {
    // Only the token the caret is in counts, so an "@" earlier in the message
    // does not keep the menu open.
    const upToCaret = value.slice(0, caret);
    const match = /(?:^|\s)@([a-z0-9._]*)$/i.exec(upToCaret);
    setMentionQuery(match ? match[1] : null);
  }

  function applyMention(handle: string) {
    const input = inputRef.current;
    if (!input) return;
    const caret = input.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([a-z0-9._]*)$/i, `@${handle} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(before.length, before.length);
    });
  }

  return (
    <>
      {editingPhoto && (
        <MediaEditor
          file={editingPhoto}
          onCancel={() => setEditingPhoto(null)}
          onDone={(blob, caption) => {
            const edited = new File([blob], editingPhoto.name.replace(/\.[^.]+$/, "") + ".jpg", {
              type: "image/jpeg",
            });
            setEditingPhoto(null);
            void sendAttachment(edited, caption);
          }}
        />
      )}

      {error && (
        <p className={styles.composerError} role="alert">
          {error}
        </p>
      )}

      {showGifs && (
        <GifStickerPicker
          onPickGif={(gif) => void sendGif(gif)}
          onPickSticker={(sticker: Sticker) => void sendBlobAs(sticker.blob, "sticker")}
          onClose={() => setShowGifs(false)}
        />
      )}

      {showEmoji && (
        <EmojiPicker
          onPick={(emoji) => {
            setDraft((d) => d + emoji);
            inputRef.current?.focus();
          }}
          onClose={() => setShowEmoji(false)}
        />
      )}

      {mentionMatches.length > 0 && (
        <div className={styles.mentionMenu} role="listbox" aria-label="Mention someone">
          {mentionMatches.map((handle) => (
            <button
              key={handle}
              type="button"
              role="option"
              aria-selected={false}
              className={styles.mentionOption}
              onClick={() => applyMention(handle)}
            >
              @{handle}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <div className={styles.editBar}>
          <span>Editing message</span>
          <button
            type="button"
            className={styles.recordCancel}
            onClick={() => {
              onEditDone?.();
              setDraft("");
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {showAttach && (
        <>
          <button
            type="button"
            className={styles.menuBackdrop}
            aria-label="Close attach menu"
            onClick={() => setShowAttach(false)}
          />
          <div className={styles.attachMenu} role="menu">
            <button
              type="button"
              className={styles.attachOption}
              onClick={() => {
                setShowAttach(false);
                setShowCamera(true);
              }}
            >
              <Icon name="video" size={20} />
              Camera
            </button>
            <button
              type="button"
              className={styles.attachOption}
              onClick={() => {
                setShowAttach(false);
                fileRef.current?.click();
              }}
            >
              <Icon name="attach" size={20} />
              Photo, video or document
            </button>
            <button type="button" className={styles.attachOption} onClick={shareLocation}>
              <Icon name="status" size={20} />
              Location
            </button>
            <button
              type="button"
              className={styles.attachOption}
              onClick={() => {
                setShowAttach(false);
                onShareContact?.();
              }}
            >
              <Icon name="chats" size={20} />
              Contact
            </button>
          </div>
        </>
      )}

      {showCamera && (
        <CameraSheet
          onClose={() => setShowCamera(false)}
          onCapture={(file) => setEditingPhoto(file)}
        />
      )}

      <div className={styles.composer}>
        {recording ? (
          <div className={styles.recording}>
            <span className={styles.recordingDot} />
            <span>Recording {(recordedMs / 1000).toFixed(1)}s</span>
            <button type="button" className={styles.recordCancel} onClick={() => stopRecording(true)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className={styles.field}>
            <button
              type="button"
              className={styles.composerIcon}
              aria-label="Emoji"
              onClick={() => {
                setShowEmoji((v) => !v);
                setShowGifs(false);
              }}
            >
              <Icon name="emoji" size={21} />
            </button>
            <textarea
              ref={inputRef}
              className={styles.input}
              rows={1}
              value={draft}
              placeholder="Message"
              aria-label="Message"
              disabled={busy}
              onKeyDown={onKeyDown}
              onChange={(e) => {
                setDraft(e.target.value);
                updateMentionQuery(e.target.value, e.target.selectionStart ?? 0);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                // Stop on an empty box, and also after a pause -- otherwise
                // the peer's indicator only clears on its own expiry.
                const empty = e.target.value.length === 0;
                void client?.sendTyping(target, empty);
                if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
                if (!empty) {
                  typingIdleRef.current = setTimeout(
                    () => void client?.sendTyping(target, true),
                    3000
                  );
                }
              }}
            />
            <button
              type="button"
              className={styles.composerIcon}
              aria-label="GIFs and stickers"
              onClick={() => {
                setShowGifs((v) => !v);
                setShowEmoji(false);
              }}
              disabled={busy}
            >
              <span className={styles.gifLabel}>GIF</span>
            </button>
            <button
              type="button"
              className={styles.composerIcon}
              aria-label="Attach"
              onClick={() => {
                setShowAttach((v) => !v);
                setShowEmoji(false);
                setShowGifs(false);
              }}
              disabled={busy}
            >
              <Icon name="attach" size={20} />
            </button>
          </div>
        )}

        <button
          className={styles.send}
          type="button"
          disabled={busy && !recording}
          aria-label={hasDraft ? "Send" : recording ? "Stop and send voice note" : "Record a voice note"}
          onClick={() => {
            if (hasDraft) return void sendText();
            if (recording) return stopRecording(false);
            void startRecording();
          }}
        >
          <Icon name={hasDraft ? "send" : recording ? "check" : "mic"} size={20} />
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="*/*"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (file.type.startsWith("image/")) setEditingPhoto(file);
          else void sendAttachment(file);
        }}
      />
    </>
  );
}
