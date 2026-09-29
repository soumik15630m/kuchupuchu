/** What a screen reader should say when something arrives.
 *
 * The app had 99 aria-labels and no live region at all, which means a message
 * arriving in an open chat was announced to nobody. A label describes a
 * control that is already there; only a live region reports a change.
 *
 * Pure so the wording is testable, and so the rules about *when to stay
 * quiet* are written down rather than implied. Announcing every message in a
 * busy group would bury everything else a reader is trying to hear.
 */

/** Below this, consecutive arrivals are collapsed into a count rather than
 * read out one by one. Roughly how long it takes to read one short line. */
export const COALESCE_MS = 4000;

export function announceMessage(message, nameFor, { mentionsYou = false } = {}) {
  if (!message) return null;
  // Own messages: the member just pressed send. Reading it back is noise.
  if (message.outgoing) return null;
  // System notices are generated locally and already rendered inline; a
  // reader reaches them by moving through the transcript.
  if (message.kind === "system") return null;

  const who = nameFor(message.fromEmail);
  const prefix = mentionsYou ? `${who} mentioned you` : `Message from ${who}`;
  const body = describeForSpeech(message);
  return body ? `${prefix}: ${body}` : prefix;
}

/** Collapses a burst into one announcement.
 *
 * `pending` is how many arrived within the window. One is read in full;
 * several become a count, because a reader cannot follow six overlapping
 * announcements and the count is the part they can act on.
 */
export function coalesce(pending, single) {
  if (pending <= 0) return null;
  if (pending === 1) return single;
  return `${pending} new messages`;
}

function describeForSpeech(message) {
  switch (message.kind) {
    case "text":
      // Truncated: a live region reads the whole string with no way to stop,
      // and a pasted wall of text would talk over everything after it.
      return truncate(message.body, 140);
    case "media":
      return message.viewOnce ? "a photo that can be viewed once" : "a photo";
    case "voice":
      return "a voice message";
    case "sticker":
      return "a sticker";
    case "file":
      return message.media?.name ? `a file, ${message.media.name}` : "a file";
    case "location":
      return "a location";
    case "contact":
      return "a contact card";
    default:
      return "";
  }
}

function truncate(text, max) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max)}, and more` : flat;
}
