"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import type { StoredMessage } from "@/lib/messaging/store";
import { WAVEFORM_BARS, nextPlaybackRate, peaksFrom } from "@/lib/messaging/waveform.mjs";

import styles from "./chat.module.css";

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function VoicePlayer({ message }: { message: StoredMessage }) {
  const { client } = useMessaging();
  const [url, setUrl] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[]>(() => new Array(WAVEFORM_BARS).fill(0.25));
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function load(): Promise<string | null> {
    if (url) return url;
    if (!client || !message.media) return null;
    setLoading(true);
    try {
      const blob = await client.fetchMedia(message.media);
      const objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);

      // Decoding for the waveform is best-effort: a container the browser can
      // play but not decode offline must still be playable.
      // Closed in `finally`: browsers cap concurrent AudioContexts at around
      // six, so leaking one per undecodable voice note eventually stops audio
      // decoding altogether.
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        setPeaks(peaksFrom(decoded.getChannelData(0)));
      } catch {
        // Keep the placeholder bars.
      } finally {
        void ctx?.close();
      }
      return objectUrl;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    const audio = audioRef.current;
    if (playing) {
      audio?.pause();
      return;
    }
    const ready = await load();
    if (!ready) return;
    // The src is applied by render after setUrl, so wait a tick before playing.
    requestAnimationFrame(() => {
      const el = audioRef.current;
      if (!el) return;
      el.playbackRate = rate;
      void el.play().catch(() => {});
    });
  }

  const durationMs = message.media?.durationMs;

  return (
    <div className={styles.voicePlayer}>
      <button
        type="button"
        className={styles.voiceToggle}
        onClick={toggle}
        disabled={loading}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
      >
        <Icon name={playing ? "micOff" : "send"} size={16} />
      </button>

      <div className={styles.waveform} aria-hidden>
        {peaks.map((peak, i) => (
          <span
            key={i}
            className={styles.waveBar}
            data-played={i / peaks.length <= progress ? "true" : undefined}
            style={{ height: `${Math.max(12, peak * 100)}%` }}
          />
        ))}
      </div>

      <div className={styles.voiceMeta}>
        <span>{durationMs != null ? formatDuration(durationMs) : "--:--"}</span>
        <button
          type="button"
          className={styles.voiceRate}
          onClick={() => {
            const next = nextPlaybackRate(rate);
            setRate(next);
            if (audioRef.current) audioRef.current.playbackRate = next;
          }}
          aria-label={`Playback speed ${rate}x`}
        >
          {rate}×
        </button>
      </div>

      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration > 0) setProgress(el.currentTime / el.duration);
          }}
        />
      )}
    </div>
  );
}
