export type CallOutcome = "completed" | "missed" | "failed";

export interface CallRecord {
  id: string;
  /** Chat id the call belongs to: an email for 1:1, a group id otherwise. */
  chatId: string;
  outgoing: boolean;
  video: boolean;
  startedAtMs: number;
  /** Null while the call is still up, or when it never connected. */
  durationMs: number | null;
  outcome: CallOutcome;
}

const KEY = "kuchupuchu:call-log";
const MAX_ENTRIES = 300;

/** Local-only. A shared call history would need its own encrypted message kind
 * and would tell the server who called whom; the log is a per-device
 * convenience, not a record either side depends on. */
export function loadCallLog(): CallRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as CallRecord[]) : [];
  } catch {
    return [];
  }
}

function write(records: CallRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(records.slice(0, MAX_ENTRIES)));
  } catch {
    // History is expendable; never let it break a call.
  }
}

export function recordCallStarted(chatId: string, outgoing: boolean, video: boolean): string {
  const record: CallRecord = {
    id: crypto.randomUUID(),
    chatId,
    outgoing,
    video,
    startedAtMs: Date.now(),
    durationMs: null,
    // Pessimistic until it connects, so a call that never went through is not
    // silently logged as a success.
    outcome: "failed",
  };
  write([record, ...loadCallLog()]);
  return record.id;
}

export function finishCall(id: string, outcome: CallOutcome, connectedAtMs: number | null): void {
  const records = loadCallLog();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return;

  records[index] = {
    ...records[index],
    outcome,
    durationMs: connectedAtMs ? Date.now() - connectedAtMs : null,
  };
  write(records);
}

export function clearCallLog(): void {
  write([]);
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
