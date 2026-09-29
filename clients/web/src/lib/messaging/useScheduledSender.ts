"use client";

import { useEffect } from "react";

import { getGroup } from "../groups";
import type { MessagingClient } from "./client";
import { nextDelayMs } from "./scheduled.mjs";
import { SCHEDULED_CHANGED, claimDue, loadScheduled } from "./scheduled-store";

/** Sends what is due, while the app is running.
 *
 * The limit is real and the UI says it: no background send exists. A browser
 * cannot be relied on to run code at a chosen moment with the tab closed, so
 * a message scheduled for 9am on a machine that is shut at 9am goes out when
 * the app next opens. Claiming otherwise would mean a member believing a
 * message was sent when it was not.
 *
 * Sleeps until the next one rather than polling: a queue of one should not
 * mean a timer firing every second for an hour.
 */
export function useScheduledSender(
  client: MessagingClient | null,
  onSent: (chatId: string, lateBySentAtMs: number, atMs: number) => void
): void {
  useEffect(() => {
    if (!client) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const arm = () => {
      if (timer) clearTimeout(timer);
      const delay = nextDelayMs(loadScheduled(), Date.now());
      timer = delay === null ? null : setTimeout(() => void run(), delay);
    };

    const run = async () => {
      if (stopped) return;
      for (const entry of claimDue()) {
        const group = entry.isGroup ? getGroup(entry.chatId) : null;
        const target = group
          ? ({ kind: "group", group } as const)
          : ({ kind: "direct", email: entry.chatId } as const);
        try {
          await client.send(target, { kind: "text", body: entry.body });
          onSent(entry.chatId, Date.now(), entry.atMs);
        } catch {
          // The send path already stored a failed bubble with a retry. It is
          // not put back in the queue: two copies racing to deliver the same
          // message is worse than one the member can see and retry.
        }
      }
      if (stopped) return;
      arm();
    };

    void run();

    // Also on the way back: a laptop that slept through the appointed time
    // should send when it wakes, not when its timer next happens to fire.
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Re-arm when something is queued or cancelled. Without this the delay
    // computed at mount is the only one there is, and a message scheduled in
    // an already-open tab waits for a reload.
    const onQueueChanged = () => arm();
    window.addEventListener(SCHEDULED_CHANGED, onQueueChanged);
    // And when another tab changes it -- the queue is shared storage, and the
    // tab that sends should be whichever one is awake.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === "kuchupuchu:scheduled") arm();
    };
    window.addEventListener("storage", onStorage);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(SCHEDULED_CHANGED, onQueueChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [client, onSent]);
}
