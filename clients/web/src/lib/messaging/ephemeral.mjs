/** Disappearing messages, and the window in which a sent message can still
 * be edited.
 *
 * Both are rules about how long a message stays what it is, and both are
 * pure so they can be tested without a clock or a store.
 *
 * The expiry is an absolute timestamp computed by the *sender* and carried
 * inside the envelope, not a duration each side applies to its own clock.
 * Two devices whose clocks disagree would otherwise delete at different
 * moments, and the one that runs slow would keep the message longest --
 * exactly backwards from what the setting promises.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** WhatsApp and Signal both offer roughly this ladder. "Off" is a real
 * option rather than a zero, so a chat that never had a timer and a chat
 * where someone turned it off read the same. */
export const EPHEMERAL_DURATIONS = [
  { label: "Off", ms: 0 },
  { label: "24 hours", ms: DAY },
  { label: "7 days", ms: 7 * DAY },
  { label: "90 days", ms: 90 * DAY },
];

/** Editing closes after 15 minutes, matching WhatsApp. An unbounded window
 * means a message someone replied to an hour ago can be rewritten under the
 * reply, which makes the quoted text a lie with no trace. */
export const EDIT_WINDOW_MS = 15 * MINUTE;

export function isKnownDuration(ms) {
  return EPHEMERAL_DURATIONS.some((d) => d.ms === ms);
}

export function describeDuration(ms) {
  return EPHEMERAL_DURATIONS.find((d) => d.ms === ms)?.label ?? "Off";
}

/** The clock starts at send, not at read.
 *
 * Signal starts a recipient's copy when they read it, which means an unread
 * message lives forever and the two sides hold it for different lengths.
 * Starting at send is what "this conversation should not outlive the week"
 * actually means, and it is the same instant on every device. */
export function expiryFor(sentAtMs, durationMs) {
  if (!durationMs || durationMs <= 0) return undefined;
  return sentAtMs + durationMs;
}

export function isExpired(message, nowMs) {
  return typeof message.expiresAtMs === "number" && message.expiresAtMs <= nowMs;
}

export function expiredAmong(messages, nowMs) {
  return messages.filter((m) => isExpired(m, nowMs));
}

/** How long until the soonest expiry, clamped so the sweep neither spins nor
 * sleeps through a deletion. Null when nothing is due. */
export function nextSweepDelayMs(messages, nowMs, { min = 15 * 1000, max = 5 * MINUTE } = {}) {
  const pending = messages
    .map((m) => m.expiresAtMs)
    .filter((t) => typeof t === "number" && t > nowMs);
  if (pending.length === 0) return null;
  return Math.min(max, Math.max(min, Math.min(...pending) - nowMs));
}

/** Whether the author can still edit. Deliberately not "is this mine" alone:
 * a deleted message has no body to edit, and a media caption edit would have
 * to re-key the blob. */
export function canEdit(message, nowMs, selfEmail) {
  if (!message.outgoing || message.fromEmail !== selfEmail) return false;
  if (message.deletedForEveryone) return false;
  if (message.kind !== "text") return false;
  return nowMs - message.sentAtMs <= EDIT_WINDOW_MS;
}

export function editWindowRemainingMs(message, nowMs) {
  return Math.max(0, message.sentAtMs + EDIT_WINDOW_MS - nowMs);
}

/** The line shown when the timer changes. Generated locally on both sides
 * from the control message, so it is never a bubble anyone sent. */
export function timerNotice(actorName, durationMs) {
  return durationMs > 0
    ? `${actorName} set disappearing messages to ${describeDuration(durationMs)}`
    : `${actorName} turned off disappearing messages`;
}
