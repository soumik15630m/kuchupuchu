/** Find-in-conversation: the next/previous walk through matches in one chat.
 *
 * Separate from the global search in `store.ts`, which answers "which chat
 * was that in". This one answers "show me the next one", which is a cursor
 * over an ordered list and nothing else -- so it is pure, and the chat screen
 * only has to scroll to what it returns.
 */

/** Indices of the messages that match, in chat order.
 *
 * Matching on the searchable text rather than the raw body so a document's
 * filename and a location's label are findable, and formatting markers do
 * not have to be typed to match what is rendered.
 */
export function matchIndices(messages, query, describe) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.deletedForEveryone) continue;
    if (describe(message).toLowerCase().includes(needle)) found.push(i);
  }
  return found;
}

/** Moves the cursor, wrapping at both ends.
 *
 * Wrapping rather than stopping: a search that goes quiet at the last match
 * reads as broken, and there is nowhere else for "next" to mean.
 */
export function step(cursor, total, direction) {
  if (total <= 0) return -1;
  if (cursor < 0) return direction > 0 ? 0 : total - 1;
  return (cursor + direction + total) % total;
}

/** Newest first is the useful default: the thing someone is looking for in a
 * conversation they are already reading is usually recent. */
export function initialCursor(total) {
  return total > 0 ? total - 1 : -1;
}

/** "3 of 12", or nothing when there is no search running. */
export function describeProgress(cursor, total) {
  if (total === 0) return "No matches";
  return `${cursor + 1} of ${total}`;
}

/** Splits text around every occurrence of the query, so the caller can mark
 * the matching runs without building a regex from user input -- which would
 * turn a typed `(` into a syntax error. */
export function highlightParts(text, query) {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];

  const parts = [];
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(lowered, at);
    if (found === -1) break;
    if (found > at) parts.push({ text: text.slice(at, found), match: false });
    parts.push({ text: text.slice(found, found + needle.length), match: true });
    at = found + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
