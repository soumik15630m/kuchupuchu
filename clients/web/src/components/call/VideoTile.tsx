"use client";

import { Track } from "livekit-client";
import { useEffect, useRef } from "react";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import type { ParticipantView } from "@/lib/call/engine";

import styles from "./call.module.css";

export function VideoTile({
  participant,
  mirrored,
  onVideoEl,
}: {
  participant: ParticipantView;
  mirrored?: boolean;
  /** Handed up so the call screen can put this element into picture-in-picture;
   * only one element can hold PiP, so the page owns the choice. */
  onVideoEl?: (el: HTMLVideoElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const track = participant.videoTrack;

  useEffect(() => {
    const el = ref.current;
    if (!el || !track || track.kind !== Track.Kind.Video) return;
    track.attach(el);
    onVideoEl?.(el);
    return () => {
      track.detach(el);
      onVideoEl?.(null);
    };
  }, [track, onVideoEl]);

  return (
    <div className={styles.tile} data-speaking={participant.speaking ? "true" : undefined}>
      {track ? (
        <video
          ref={ref}
          className={styles.video}
          autoPlay
          playsInline
          muted={participant.isLocal}
          data-mirrored={mirrored ? "true" : undefined}
        />
      ) : (
        <Avatar
          email={participant.email}
          label={participant.email}
          size={72}
          className={styles.tileAvatar}
        />
      )}

      <div className={styles.tileLabel}>
        {participant.audioMuted && <Icon name="micOff" size={13} />}
        <span>{participant.isLocal ? "You" : participant.email}</span>
      </div>
    </div>
  );
}
