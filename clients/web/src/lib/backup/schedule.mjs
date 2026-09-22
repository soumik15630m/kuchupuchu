/** When an automatic backup is due.
 *
 * Kept pure because the alternative is testing it by waiting a day. The
 * caller polls this; nothing here reads a clock of its own.
 *
 * A backup is not cheap -- 600k PBKDF2 iterations plus re-uploading the whole
 * archive -- so it must not fire on every app start, and it must not fire
 * while the last attempt is still in flight. The rules below exist to keep
 * both of those from happening.
 */

export const FREQUENCIES = Object.freeze(["off", "daily", "weekly", "monthly"]);

const INTERVALS_MS = Object.freeze({
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
});

/** How long after a failure before trying again. Without this, a member who
 * is offline for a week gets one failed attempt per poll for a week. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** A run that never reported back is treated as dead after this, so a tab
 * closed mid-backup does not wedge the schedule permanently. */
export const STALE_RUN_MS = 30 * 60 * 1000;

export function defaultSettings() {
  return {
    frequency: "off",
    includeMedia: true,
    lastSuccessMs: null,
    lastAttemptMs: null,
    lastError: null,
    runningSinceMs: null,
  };
}

export function intervalFor(frequency) {
  return INTERVALS_MS[frequency] ?? null;
}

/**
 * @returns {number|null} when the next automatic run is due, or null if off
 */
export function nextRunAtMs(settings, nowMs) {
  const interval = intervalFor(settings.frequency);
  if (interval === null) return null;

  // Never backed up on this schedule: due now rather than one interval from
  // now, otherwise turning on "weekly" means no backup at all for a week.
  if (!settings.lastSuccessMs) {
    if (settings.lastError && settings.lastAttemptMs) {
      return settings.lastAttemptMs + RETRY_AFTER_MS;
    }
    return nowMs;
  }

  const scheduled = settings.lastSuccessMs + interval;
  if (settings.lastError && settings.lastAttemptMs) {
    // Back off from the failure, but never past the next scheduled slot.
    return Math.max(scheduled, settings.lastAttemptMs + RETRY_AFTER_MS);
  }
  return scheduled;
}

export function isDue(settings, nowMs) {
  if (settings.frequency === "off") return false;
  if (settings.runningSinceMs && nowMs - settings.runningSinceMs < STALE_RUN_MS) return false;
  const next = nextRunAtMs(settings, nowMs);
  return next !== null && nowMs >= next;
}

/** Normalises whatever came out of storage. A settings blob written by a
 * newer build, or half-edited by hand, must not take the schedule down. */
export function normaliseSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  return {
    frequency: FREQUENCIES.includes(raw.frequency) ? raw.frequency : base.frequency,
    includeMedia: typeof raw.includeMedia === "boolean" ? raw.includeMedia : base.includeMedia,
    lastSuccessMs: Number.isFinite(raw.lastSuccessMs) ? raw.lastSuccessMs : null,
    lastAttemptMs: Number.isFinite(raw.lastAttemptMs) ? raw.lastAttemptMs : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    runningSinceMs: Number.isFinite(raw.runningSinceMs) ? raw.runningSinceMs : null,
  };
}
