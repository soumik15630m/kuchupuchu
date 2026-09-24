"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { useDirectory } from "@/lib/directory/DirectoryProvider";
import { getGroup, isGroupId } from "@/lib/groups";
import { useMessaging } from "@/lib/messaging/MessagingProvider";
import { targetFor } from "@/lib/messaging/useChatTarget";

import styles from "./call.module.css";

/** The ringing banner.
 *
 * Mounted once near the root so it shows wherever the member happens to be.
 * Lock-screen ringing needs the wake service; this is what the web client can
 * honestly do today, and it is the difference between a callee who learns
 * about a call and one who does not.
 */
export function IncomingCall() {
  const router = useRouter();
  const { incomingCall, dismissIncomingCall, client } = useMessaging();
  const { nameFor } = useDirectory();
  const toneRef = useRef<{ ctx: AudioContext; stop: () => void } | null>(null);

  // A ringtone the page synthesises rather than ships: no asset, no decode,
  // and it stops dead when the banner goes. Autoplay policy may refuse it,
  // which is why the banner never depends on it being audible.
  useEffect(() => {
    if (!incomingCall) return;
    let cancelled = false;
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 440;
      osc.connect(gain);
      osc.start();
      const pulse = setInterval(() => {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      }, 1800);
      toneRef.current = {
        ctx,
        stop: () => {
          clearInterval(pulse);
          osc.stop();
          void ctx.close();
        },
      };
      if (cancelled) toneRef.current.stop();
    } catch {
      // No audio is survivable; the banner is the part that matters.
    }
    return () => {
      cancelled = true;
      toneRef.current?.stop();
      toneRef.current = null;
    };
  }, [incomingCall]);

  if (!incomingCall) return null;

  const { chatId, video, fromEmail } = incomingCall;
  const title = isGroupId(chatId) ? (getGroup(chatId)?.name ?? "Group call") : nameFor(fromEmail);
  const subtitle = isGroupId(chatId)
    ? `${nameFor(fromEmail)} is calling the group`
    : video
      ? "Incoming video call"
      : "Incoming voice call";

  function decline() {
    const target = targetFor(chatId);
    if (target && client) void client.signalCall(target, "call-decline", video).catch(() => {});
    dismissIncomingCall();
  }

  function accept() {
    dismissIncomingCall();
    // `incoming` so the call page logs this as a received call and does not
    // ring the caller back.
    router.push(
      `/call/${encodeURIComponent(chatId)}?incoming=1${video ? "&video=1" : ""}`
    );
  }

  return (
    <div className={styles.incoming} role="alertdialog" aria-label={subtitle}>
      <Avatar email={fromEmail} label={title} size={44} className={styles.incomingAvatar} />
      <div className={styles.incomingWho}>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <button
        type="button"
        className={`${styles.incomingButton} ${styles.incomingDecline}`}
        onClick={decline}
        aria-label="Decline"
      >
        <Icon name="hangup" size={20} />
      </button>
      <button
        type="button"
        className={`${styles.incomingButton} ${styles.incomingAccept}`}
        onClick={accept}
        aria-label="Answer"
      >
        <Icon name={video ? "video" : "phone"} size={20} />
      </button>
    </div>
  );
}
