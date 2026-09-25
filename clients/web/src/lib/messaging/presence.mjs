/** Turning a presence entry into the line under someone's name.
 *
 * Pure so the wording can be tested without a clock or a socket. The rules
 * are deliberately coarse -- "today at 14:05" rather than "14:05:33" -- and
 * there is no "2 minutes ago": a precise last-seen is a surveillance surface,
 * and rounding it costs the reader nothing.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function presenceLabel(entry, nowMs, formatTime, formatDate) {
  if (!entry) return null;
  if (entry.online) return "online";
  if (!entry.lastSeenAt) return null;

  const seen = Date.parse(entry.lastSeenAt);
  if (!Number.isFinite(seen)) return null;

  const age = nowMs - seen;
  // A clock skewed slightly into the future should read as "just now", not
  // as a date next week.
  if (age < 2 * MINUTE) return "last seen just now";
  if (age < HOUR) return `last seen ${Math.round(age / MINUTE)} minutes ago`;

  const sameDay = new Date(seen).toDateString() === new Date(nowMs).toDateString();
  if (sameDay) return `last seen today at ${formatTime(seen)}`;

  const yesterday = new Date(nowMs - DAY).toDateString() === new Date(seen).toDateString();
  if (yesterday) return `last seen yesterday at ${formatTime(seen)}`;

  return `last seen ${formatDate(seen)}`;
}
