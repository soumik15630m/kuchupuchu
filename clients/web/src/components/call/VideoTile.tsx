"use client";

import { Track } from "livekit-client";
import { useEffect, useRef } from "react";

import { Icon } from "@/components/Icon";
import { initialsFor } from "@/lib/directory/DirectoryProvider";
import type { ParticipantView } from "@/lib/call/engine";

import styles from "./call.module.css";

export function VideoTile({ participant, mirrored }: { participant: ParticipantView; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const track = participant.videoTrack;

  useEffect(() => {
    const el = ref.current;
    if (!el || !track || track.kind !== Track.Kind.Video) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

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
        <div className={styles.tileAvatar}>{initialsFor(participant.email)}</div>
      )}

      <div className={styles.tileLabel}>
        {participant.audioMuted && <Icon name="micOff" size={13} />}
        <span>{participant.isLocal ? "You" : participant.email}</span>
      </div>
    </div>
  );
}
