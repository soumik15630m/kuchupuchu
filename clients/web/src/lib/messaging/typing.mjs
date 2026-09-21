// Who is typing, per conversation.
//
// Pure and separate from the provider so the rules are testable without a
// browser: the original bug here was a single global "who is typing" value,
// which could only ever be right for one chat and was never right for a group
// at all.
//
// Two invariants worth stating, because both were broken before:
//   - state is keyed by conversation, not by sender alone;
//   - an entry expires on its own, because a peer that closes the tab
//     mid-typing never sends the stop.

export const TYPING_EXPIRY_MS = 5000;

/** @returns {Map<string, {email: string, expiresAtMs: number}[]>} */
export function emptyTyping() {
  return new Map();
}

/**
 * Folds one typing event in. Returns a new Map; never mutates the input.
 *
 * @param {Map<string, {email: string, expiresAtMs: number}[]>} state
 * @param {{chatId: string, fromEmail: string, stopped: boolean}} event
 * @param {number} nowMs
 */
export function applyTyping(state, event, nowMs) {
  const { chatId, fromEmail, stopped } = event;
  const next = new Map(state);
  const current = (next.get(chatId) ?? []).filter((e) => e.email !== fromEmail);

  if (stopped) {
    if (current.length === 0) next.delete(chatId);
    else next.set(chatId, current);
    return next;
  }

  next.set(chatId, [...current, { email: fromEmail, expiresAtMs: nowMs + TYPING_EXPIRY_MS }]);
  return next;
}

/** Drops entries whose expiry has passed. */
export function pruneTyping(state, nowMs) {
  const next = new Map();
  for (const [chatId, entries] of state) {
    const live = entries.filter((e) => e.expiresAtMs > nowMs);
    if (live.length > 0) next.set(chatId, live);
  }
  return next;
}

/** Addresses currently typing in `chatId`, oldest first. */
export function typistsIn(state, chatId, nowMs) {
  return (state.get(chatId) ?? []).filter((e) => e.expiresAtMs > nowMs).map((e) => e.email);
}

/** In a group it matters who is typing; in a 1:1 the name is redundant. */
export function typingLabel(names, isGroup) {
  if (names.length === 0) return null;
  if (!isGroup) return "typing…";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}
