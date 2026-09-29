import { add, remove } from "./scheduled.mjs";

/** Where scheduled messages wait.
 *
 * localStorage rather than IndexedDB: the queue is a handful of short strings,
 * and keeping it synchronous means the composer can show what is queued
 * without a render pass where it appears empty.
 *
 * Text only, deliberately. Holding a photo here would mean holding the blob
 * too, and a queue that can silently consume a member's storage quota for a
 * message that has not been sent is a different feature with different
 * problems. The composer says so rather than failing at send time.
 */

const KEY = "kuchupuchu:scheduled";

/** Fired whenever the queue changes, so the runner can re-arm its timer.
 *
 * Without this the runner computes one delay when it mounts and never hears
 * about anything queued afterwards -- so a message scheduled in an
 * already-open tab sat there until the next reload. localStorage's own
 * `storage` event does not fire in the tab that wrote the value, which is
 * exactly the tab that needs to know. */
export const SCHEDULED_CHANGED = "kuchupuchu:scheduled-changed";

function announceChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SCHEDULED_CHANGED));
}

export interface ScheduledMessage {
  id: string;
  chatId: string;
  /** The chat target, re-derived at send time from chatId; stored so a group
   * that has since changed still sends to the roster it was written for. */
  isGroup: boolean;
  body: string;
  atMs: number;
  createdAtMs: number;
}

export function loadScheduled(): ScheduledMessage[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ScheduledMessage[])
      .filter((e) => e && typeof e.body === "string" && Number.isFinite(e.atMs))
      .sort((a, b) => a.atMs - b.atMs);
  } catch {
    return [];
  }
}

function save(queue: ScheduledMessage[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // Quota. The caller reports it rather than the message vanishing quietly.
  }
  announceChange();
}

export function schedule(entry: Omit<ScheduledMessage, "id" | "createdAtMs">): ScheduledMessage {
  const full: ScheduledMessage = {
    ...entry,
    id: crypto.randomUUID(),
    createdAtMs: Date.now(),
  };
  save(add(loadScheduled(), full) as ScheduledMessage[]);
  return full;
}

export function unschedule(id: string): ScheduledMessage[] {
  const next = remove(loadScheduled(), id) as ScheduledMessage[];
  save(next);
  return next;
}

/** Takes the due entries out of the queue and returns them.
 *
 * Removed *before* sending, not after: a send that fails leaves a failed
 * bubble in the chat with a retry, which is the outbox's job. Leaving it
 * queued as well would mean two copies racing to deliver the same message.
 */
export function claimDue(nowMs = Date.now()): ScheduledMessage[] {
  const queue = loadScheduled();
  const ready = queue.filter((e) => e.atMs <= nowMs);
  if (ready.length > 0) save(queue.filter((e) => e.atMs > nowMs));
  return ready;
}
