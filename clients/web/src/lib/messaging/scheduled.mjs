/** Messages queued to send later.
 *
 * The reason this is worth having here specifically: the two ends of this
 * group are about eight and a half hours apart, so one of them is routinely
 * asleep when the other has something to say. "Send this when they are awake"
 * is a real need, not a productivity gimmick.
 *
 * The honest limit, stated here because the UI has to say it too: a scheduled
 * message goes out when the app is **running** and the time has passed. There
 * is no background send. The service worker can wake for an incoming push,
 * but nothing lets a browser reliably run code at a chosen moment with the
 * tab closed, and pretending otherwise would mean a message the member
 * believes was sent and was not. If the app is shut at the appointed time, it
 * sends on next open and the UI says when it actually went.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Far enough out to be useful, near enough that a queue does not become an
 * archive of things someone forgot they wrote. */
export const MAX_AHEAD_MS = 30 * DAY;
/** Below this the member should just press send. */
export const MIN_AHEAD_MS = 30 * 1000;

export function presets(nowMs) {
  const now = new Date(nowMs);

  const at = (dayOffset, hour) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };

  // Tonight only while it is still ahead; offering "8pm" at 11pm is offering
  // to send a message in the past.
  const tonight = at(0, 20);
  const options = [{ label: "In an hour", atMs: nowMs + HOUR }];
  if (tonight > nowMs + MIN_AHEAD_MS) options.push({ label: "Tonight, 8pm", atMs: tonight });
  options.push({ label: "Tomorrow, 9am", atMs: at(1, 9) });
  return options;
}

export function validate(atMs, nowMs) {
  if (!Number.isFinite(atMs)) return "Pick a time.";
  if (atMs - nowMs < MIN_AHEAD_MS) return "Pick a time at least a minute from now.";
  if (atMs - nowMs > MAX_AHEAD_MS) return "Pick a time within the next 30 days.";
  return null;
}

export function add(queue, entry) {
  // Sorted on insert so the runner only ever looks at the head, and the UI
  // lists them in the order they will go.
  return [...queue, entry].sort((a, b) => a.atMs - b.atMs);
}

export function remove(queue, id) {
  return queue.filter((entry) => entry.id !== id);
}

export function due(queue, nowMs) {
  return queue.filter((entry) => entry.atMs <= nowMs);
}

export function pending(queue, nowMs) {
  return queue.filter((entry) => entry.atMs > nowMs);
}

export function forChat(queue, chatId) {
  return queue.filter((entry) => entry.chatId === chatId);
}

/** How long to sleep before the next one is due, clamped so the timer neither
 * spins nor sleeps past the moment. Null when nothing is queued. */
export function nextDelayMs(queue, nowMs, { min = 1000, max = 60 * 1000 } = {}) {
  const upcoming = pending(queue, nowMs);
  if (upcoming.length === 0) return null;
  return Math.min(max, Math.max(min, upcoming[0].atMs - nowMs));
}

/** The line under the composer. Deliberately says the date as well as the
 * time once it is not today -- "at 9:00" on its own is ambiguous the moment
 * more than one day is involved. */
export function describeWhen(atMs, nowMs, formatTime, formatDate) {
  const sameDay = new Date(atMs).toDateString() === new Date(nowMs).toDateString();
  if (sameDay) return `today at ${formatTime(atMs)}`;
  const tomorrow = new Date(nowMs + DAY).toDateString() === new Date(atMs).toDateString();
  if (tomorrow) return `tomorrow at ${formatTime(atMs)}`;
  return `${formatDate(atMs)} at ${formatTime(atMs)}`;
}

/** Said when a scheduled message went out later than planned because the app
 * was closed. Reporting it rather than hiding it: the member chose a time,
 * and if it was missed they should know by how much. */
export function lateBy(entry, sentAtMs) {
  const late = sentAtMs - entry.atMs;
  if (late < 2 * MINUTE) return null;
  if (late < HOUR) return `${Math.round(late / MINUTE)} minutes late`;
  if (late < DAY) return `${Math.round(late / HOUR)} hours late`;
  return `${Math.round(late / DAY)} days late`;
}
