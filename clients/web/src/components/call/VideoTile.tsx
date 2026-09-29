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
  handRaised,
  pinned,
  isMain,
  onTogglePin,
}: {
  participant: ParticipantView;
  mirrored?: boolean;
  /** Handed up so the call screen can put this element into picture-in-picture;
   * only one element can hold PiP, so the page owns the choice. */
  onVideoEl?: (el: HTMLVideoElement | null) => void;
  handRaised?: boolean;
  pinned?: boolean;
  /** Whether this tile currently fills the main slot — pinned, or the active
   * speaker when nothing is pinned. */
  isMain?: boolean;
  onTogglePin?: () => void;
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
    <div
      className={styles.tile}
      data-speaking={participant.speaking ? "true" : undefined}
      data-main={isMain ? "true" : undefined}
      data-pinned={pinned ? "true" : undefined}
    >
      {handRaised && (
        <span className={styles.tileHand} aria-label="Hand raised">
          <Icon name="hand" size={15} />
        </span>
      )}
      {onTogglePin && (
        <button
          type="button"
          className={styles.tilePin}
          aria-label={pinned ? "Unpin this person" : "Pin this person to the main view"}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          <Icon name="pin" size={14} />
        </button>
      )}
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
