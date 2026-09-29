/** Pinned messages: the handful a chat keeps at the top.
 *
 * Shared with the other side rather than kept locally, because the point of
 * pinning the address or the plan is that everyone sees the same one. That
 * makes it a control message, and makes the merge rules below matter: two
 * people can pin at the same time from devices that have not spoken yet.
 */

/** WhatsApp allows three. A cap is what stops "pinned" meaning "most of the
 * chat", and three fits a banner without a scroll of its own. */
export const MAX_PINS = 3;

/** Adds a pin, newest first, evicting the oldest once full.
 *
 * Silently evicting is better than refusing: someone who pins a fourth thing
 * means it, and an error they have to resolve by finding and unpinning an
 * older one is work the app can do for them. Returns a new array.
 */
export function addPin(pinned, id) {
  const without = pinned.filter((existing) => existing !== id);
  return [id, ...without].slice(0, MAX_PINS);
}

export function removePin(pinned, id) {
  return pinned.filter((existing) => existing !== id);
}

export function isPinned(pinned, id) {
  return pinned.includes(id);
}

/** Applies a pin change that arrived from the other side.
 *
 * Deliberately the same function as the local path, so two devices that
 * apply the same set of changes in the same order agree. They can still
 * diverge if the order differs -- the loser is whichever pin fell off the
 * end -- which is a cosmetic disagreement about a three-item list, not worth
 * a version vector to prevent.
 */
export function applyPinChange(pinned, id, pin) {
  return pin ? addPin(pinned, id) : removePin(pinned, id);
}

/** Pins whose message is no longer here -- deleted, or disappeared.
 *
 * A pin pointing at nothing would render an empty banner that cannot be
 * dismissed, so the caller prunes with this rather than filtering at render
 * time and leaving the stale id in storage forever.
 */
export function prunePins(pinned, existingIds) {
  const present = new Set(existingIds);
  return pinned.filter((id) => present.has(id));
}

/** The pinned messages themselves, in pin order rather than chat order. */
export function pinnedMessages(pinned, messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return pinned.map((id) => byId.get(id)).filter(Boolean);
}
