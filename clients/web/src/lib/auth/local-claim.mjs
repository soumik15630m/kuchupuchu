/** Who this browser's stored chats belong to, and when to throw them away.
 *
 * Isolated from the storage calls so the rule itself can be tested: getting it
 * wrong in either direction is bad. Too eager and a member loses their history
 * every time they sign in; too lax and the next person to use this browser
 * opens it to someone else's conversations.
 */

export const KUCHUPUCHU_DB_PREFIX = "kuchupuchu-";

/** localStorage keys that hold per-member state. The theme is not here on
 * purpose -- it is a display preference, not anyone's data, and wiping it
 * would just make the app flash back to defaults for no privacy gain. */
export const LOCAL_KEYS = [
  "kuchupuchu:groups",
  "kuchupuchu:chat-settings",
  "kuchupuchu:call-log",
  "kuchupuchu:history-asked",
  "kuchupuchu:app-lock",
  "kuchupuchu:unlocked-at",
  "kuchupuchu:notifications",
  "kuchupuchu:link-previews",
];

/**
 * @param {{owner: string|null, next: string, hasData: boolean}} input
 * @returns {{wipe: boolean, reason: string}}
 */
export function decideLocalClaim({ owner, next, hasData }) {
  const target = (next ?? "").toLowerCase();
  if (owner && owner.toLowerCase() === target) {
    return { wipe: false, reason: "same-member" };
  }
  if (owner) {
    return { wipe: true, reason: "different-member" };
  }
  // No owner recorded. Either a genuinely fresh browser, or an install from
  // before this key existed. Data present with nobody's name on it cannot be
  // proven to belong to the person signing in, so it goes -- history sync can
  // restore it from their other device, whereas a leak cannot be undone.
  if (hasData) return { wipe: true, reason: "unowned-data" };
  return { wipe: false, reason: "fresh" };
}
