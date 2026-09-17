"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { EmojiPicker } from "@/components/chat/EmojiPicker";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { compressImage, makeThumbnail, pickVoiceMimeType, videoPoster } from "@/lib/messaging/media";

import styles from "./chat.module.css";

export function Composer({ peerEmail }: { peerEmail: string }) {
  const { client } = useMessaging();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedMs, setRecordedMs] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function sendText() {
    const body = draft.trim();
    if (!body || !client) return;
    setDraft("");
    setError(null);
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      await client.sendTyping(peerEmail, true);
      await client.send(peerEmail, { kind: "text", body });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that.");
    }
  }

  async function sendAttachment(file: File) {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const isVideo = file.type.startsWith("video/");
      let blob: Blob = file;
      let width: number | undefined;
      let height: number | undefined;
      let thumb: string | undefined;
      let durationMs: number | undefined;

      if (file.type.startsWith("image/")) {
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

      const { mediaId, key, iv } = await client.uploadMedia(peerEmail, blob);
      await client.send(peerEmail, {
        kind: "media",
        body: "",
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
        const { mediaId, key, iv } = await client.uploadMedia(peerEmail, blob);
        await client.send(peerEmail, {
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

  return (
    <>
      {error && (
        <p className={styles.composerError} role="alert">
          {error}
        </p>
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
              onClick={() => setShowEmoji((v) => !v)}
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
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                void client?.sendTyping(peerEmail, e.target.value.length === 0);
              }}
            />
            <button
              type="button"
              className={styles.composerIcon}
              aria-label="Attach a photo or video"
              onClick={() => fileRef.current?.click()}
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
        accept="image/*,video/*"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void sendAttachment(file);
        }}
      />
    </>
  );
}
