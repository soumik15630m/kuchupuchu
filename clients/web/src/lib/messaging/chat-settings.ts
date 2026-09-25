const KEY = "kuchupuchu:chat-settings";

export interface ChatSettings {
  archived?: boolean;
  pinned?: boolean;
  /** Epoch ms the mute expires, or `Infinity` when muted indefinitely. */
  mutedUntilMs?: number;
  draft?: string;
  /** Set by "mark as unread". Cleared when the chat is next opened, so it is
   * a reminder rather than a state the member has to undo by hand. */
  unreadMark?: boolean;
}

type AllSettings = Record<string, ChatSettings>;

/** Per-device, not synced. Archiving a chat on a laptop is a view preference,
 * not something the other person's device should learn about — and syncing it
 * would mean another message kind on the wire for no real benefit. */
function readAll(): AllSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as AllSettings) : {};
  } catch {
    return {};
  }
}

function writeAll(settings: AllSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Quota; preferences degrade to defaults rather than breaking the list.
  }
}

export function loadChatSettings(): AllSettings {
  const all = readAll();
  // `Infinity` does not survive JSON, so an indefinite mute is stored as null
  // and restored here.
  for (const value of Object.values(all)) {
    if (value.mutedUntilMs === null) value.mutedUntilMs = Infinity;
  }
  return all;
}

export function settingsFor(chatId: string): ChatSettings {
  return loadChatSettings()[chatId] ?? {};
}

export function updateChatSettings(chatId: string, patch: ChatSettings): AllSettings {
  const all = loadChatSettings();
  const merged = { ...(all[chatId] ?? {}), ...patch };

  // Drop defaults rather than storing them, so the record stays small and an
  // absent key means "never touched".
  if (!merged.archived) delete merged.archived;
  if (!merged.pinned) delete merged.pinned;
  if (!merged.draft) delete merged.draft;
  if (!merged.unreadMark) delete merged.unreadMark;
  if (merged.mutedUntilMs !== undefined && merged.mutedUntilMs <= Date.now()) {
    delete merged.mutedUntilMs;
  }

  if (Object.keys(merged).length === 0) delete all[chatId];
  else all[chatId] = merged;

  writeAll(
    Object.fromEntries(
      Object.entries(all).map(([id, s]) => [
        id,
        // JSON cannot hold Infinity; null is the sentinel loadChatSettings restores.
        s.mutedUntilMs === Infinity ? { ...s, mutedUntilMs: null as unknown as number } : s,
      ])
    )
  );
  return all;
}

export function isMuted(settings: ChatSettings, nowMs = Date.now()): boolean {
  return settings.mutedUntilMs !== undefined && settings.mutedUntilMs > nowMs;
}

export const MUTE_DURATIONS = [
  { label: "8 hours", ms: 8 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "Always", ms: Infinity },
] as const;
