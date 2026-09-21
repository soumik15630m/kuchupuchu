// What a message's ticks show, derived from per-recipient receipts.
//
// Pure, and separate from store.ts for the same reason rotation.js is separate
// from group-e2ee.js: the decision is worth exhaustive tests, the IndexedDB
// plumbing around it is not.
//
// The rule that matters: in a group the second tick only turns blue once
// EVERY recipient has read. Advancing on the first receipt says "everyone has
// seen this" when one person has, which is worse than showing nothing.

/** Ordering, so a late `delivered` cannot undo a `read` — the two receipts
 * race whenever a person has more than one device. */
export const RANK = {
  failed: -1,
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * @param {{status: string, recipients?: string[], deliveredTo?: string[], readBy?: string[]}} message
 * @returns {string} the aggregate status
 */
export function aggregateStatus(message) {
  const recipients = message.recipients;
  const delivered = message.deliveredTo ?? [];
  const read = message.readBy ?? [];
  const floor = message.status === "sending" ? "sending" : "sent";

  // No recorded recipient set: a message from before this was tracked. Falling
  // back to "any receipt counts" keeps the old reading rather than silently
  // downgrading history to a single tick.
  if (!recipients || recipients.length === 0) {
    if (read.length > 0) return "read";
    if (delivered.length > 0) return "delivered";
    return floor;
  }

  const covers = (acked) => recipients.every((r) => acked.includes(r));
  // Reading implies delivery, so someone who only reported "read" still counts
  // towards delivery.
  if (covers(read)) return "read";
  if (covers([...new Set([...delivered, ...read])])) return "delivered";
  return floor;
}

/** Folds one receipt in. Returns the new acknowledgement sets and status
 * without mutating the input. */
export function applyReceipt(message, kind, byEmail) {
  const who = (byEmail ?? "").toLowerCase();
  const deliveredTo = new Set(message.deliveredTo ?? []);
  const readBy = new Set(message.readBy ?? []);

  if (who) {
    deliveredTo.add(who);
    if (kind === "read") readBy.add(who);
  }

  const next = {
    ...message,
    deliveredTo: [...deliveredTo],
    readBy: [...readBy],
  };
  next.status = aggregateStatus(next);

  // An anonymous receipt against a message with no recipient set on record
  // cannot be attributed, so it only moves the aggregate directly.
  if (!who && message.recipients === undefined) {
    next.status = kind === "read" ? "read" : "delivered";
  }
  return next;
}
