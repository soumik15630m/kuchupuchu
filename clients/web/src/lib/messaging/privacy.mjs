/** What this device tells other people about the member using it.
 *
 * Read receipts and typing indicators are two-way by convention: WhatsApp
 * withholds other people's receipts from anyone who turns their own off, and
 * doing the same here keeps the setting from being a one-sided advantage.
 * That reciprocity is the only non-obvious rule in this file, which is why
 * the decisions live here rather than inline at the call sites.
 */

const KEY = "kuchupuchu:sharing";

export function defaultSharing() {
  return { readReceipts: true, typing: true, lastSeen: true };
}

export function normaliseSharing(raw) {
  const base = defaultSharing();
  if (!raw || typeof raw !== "object") return base;
  return {
    readReceipts: typeof raw.readReceipts === "boolean" ? raw.readReceipts : base.readReceipts,
    typing: typeof raw.typing === "boolean" ? raw.typing : base.typing,
    lastSeen: typeof raw.lastSeen === "boolean" ? raw.lastSeen : base.lastSeen,
  };
}

export function loadSharing(storage) {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (!store) return defaultSharing();
  try {
    return normaliseSharing(JSON.parse(store.getItem(KEY) ?? "null"));
  } catch {
    return defaultSharing();
  }
}

export function saveSharing(patch, storage) {
  const store = storage ?? localStorage;
  const merged = normaliseSharing({ ...loadSharing(store), ...patch });
  store.setItem(KEY, JSON.stringify(merged));
  return merged;
}

/** Whether to send a read receipt for someone else's message. */
export function shouldSendReadReceipt(sharing) {
  return sharing.readReceipts === true;
}

/** Whether to show the blue double tick on our own sent messages.
 *
 * Withheld when the member has turned their own receipts off -- otherwise
 * they would see everyone else's while sending none. */
export function shouldShowReadReceipt(sharing) {
  return sharing.readReceipts === true;
}

export function shouldSendTyping(sharing) {
  return sharing.typing === true;
}

export function shouldShowTyping(sharing) {
  return sharing.typing === true;
}

export const SHARING_KEY = KEY;
