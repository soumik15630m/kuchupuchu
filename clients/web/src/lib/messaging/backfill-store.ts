/** When each missing attachment was last asked for.
 *
 * localStorage rather than IndexedDB: it is a small map of ids to timestamps,
 * read synchronously on the path that decides whether to send a request, and
 * losing it costs one extra request rather than any data.
 */
const KEY = "kuchupuchu:backfill-asked";

export function loadAskedBackfills(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveAskedBackfills(asked: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(asked));
  } catch {
    // Quota; the worst case is asking again sooner than intended.
  }
}
