/** Who a status post goes to.
 *
 * Status is fanned out per recipient, so the audience is decided here and
 * enforced by simply not encrypting a copy for anyone excluded. There is no
 * server-side visibility flag to get wrong: someone left out never receives
 * the ciphertext at all.
 *
 * Two modes, matching what people expect:
 *   "all"     everyone, minus an exclude list
 *   "only"    nobody, plus an include list
 */

const KEY = "kuchupuchu:status-audience";

export function defaultStatusAudience() {
  return { mode: "all", except: [], only: [] };
}

export function normaliseStatusAudience(raw) {
  const base = defaultStatusAudience();
  if (!raw || typeof raw !== "object") return base;
  const list = (value) =>
    Array.isArray(value)
      ? [...new Set(value.filter((e) => typeof e === "string").map((e) => e.toLowerCase()))].sort()
      : [];
  return {
    mode: raw.mode === "only" ? "only" : "all",
    except: list(raw.except),
    only: list(raw.only),
  };
}

export function loadStatusAudience(storage) {
  const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (!store) return defaultStatusAudience();
  try {
    return normaliseStatusAudience(JSON.parse(store.getItem(KEY) ?? "null"));
  } catch {
    return defaultStatusAudience();
  }
}

export function saveStatusAudience(patch, storage) {
  const store = storage ?? localStorage;
  const merged = normaliseStatusAudience({ ...loadStatusAudience(store), ...patch });
  store.setItem(KEY, JSON.stringify(merged));
  return merged;
}

/**
 * @param {{mode: string, except: string[], only: string[]}} settings
 * @param {string[]} everyone  every member except yourself
 * @returns {string[]} who actually receives the post
 */
export function statusRecipients(settings, everyone) {
  const all = everyone.map((e) => e.toLowerCase());
  if (settings.mode === "only") {
    const allowed = new Set(settings.only);
    return all.filter((e) => allowed.has(e));
  }
  const blocked = new Set(settings.except);
  return all.filter((e) => !blocked.has(e));
}

/** A short line for the settings row, so the choice is visible without
 * opening the picker. */
export function describeStatusAudience(settings, everyone) {
  const count = statusRecipients(settings, everyone).length;
  if (settings.mode === "only") {
    return count === 0 ? "Nobody" : `Only ${count} ${count === 1 ? "person" : "people"}`;
  }
  if (settings.except.length === 0) return "Everyone";
  return `Everyone except ${settings.except.length}`;
}

export const STATUS_AUDIENCE_KEY = KEY;
