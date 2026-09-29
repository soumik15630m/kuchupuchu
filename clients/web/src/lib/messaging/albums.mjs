/** Grouping consecutive photos into one album bubble.
 *
 * Dropping five photos into a chat used to produce five bubbles, because
 * each one really is its own message -- each has its own id, its own blob
 * key, its own receipts. That stays true: an album is a *rendering* of
 * several messages, not a new kind of message. Nothing about the wire format
 * changes, and reacting to or replying to one photo still targets that photo.
 *
 * Which means this is a pure grouping pass over the list the chat already
 * has, and the rules below are the whole feature.
 */

/** Photos sent in one go land within a second or two of each other. A minute
 * is loose enough to survive a slow upload of the fifth one and tight enough
 * that two unrelated photos an hour apart stay separate. */
export const ALBUM_GAP_MS = 60 * 1000;

/** Past this the grid stops being readable and starts being a wall. The rest
 * spill into a second album, which is the right answer rather than a "+7
 * more" that hides them. */
export const ALBUM_MAX = 10;

function albumable(message) {
  if (!message) return false;
  if (message.kind !== "media") return false;
  // A view-once photo is its own experience -- it has a shield over it and
  // vanishes when opened. Tiling it with ordinary photos would either leak
  // it or break the grid.
  if (message.viewOnce) return false;
  if (message.deletedForEveryone) return false;
  // A caption is a message with something to say; burying it in a grid
  // loses the words.
  if (message.body) return false;
  return true;
}

function joins(previous, next) {
  return (
    albumable(previous) &&
    albumable(next) &&
    previous.fromEmail === next.fromEmail &&
    next.sentAtMs - previous.sentAtMs <= ALBUM_GAP_MS &&
    // A reply points at one specific message; an album has no single target.
    !next.replyTo &&
    !previous.replyTo
  );
}

/** Returns the list to render: either `{ type: "message" }` or
 * `{ type: "album", messages: [...] }`, in chat order. */
export function groupIntoAlbums(messages) {
  const out = [];
  let run = [];

  const flush = () => {
    if (run.length === 0) return;
    // A run of one is not an album. Rendering it as a one-cell grid would
    // make a single photo look different depending on what came before it.
    out.push(run.length === 1 ? { type: "message", message: run[0] } : { type: "album", messages: run });
    run = [];
  };

  for (const message of messages) {
    const last = run[run.length - 1];
    if (run.length > 0 && run.length < ALBUM_MAX && joins(last, message)) {
      run.push(message);
      continue;
    }
    flush();
    if (albumable(message)) run = [message];
    else out.push({ type: "message", message });
  }
  flush();
  return out;
}

/** How many columns to draw. Mirrors what the eye expects: a pair side by
 * side, three in a row, four as a square, more as a three-wide grid. */
export function albumColumns(count) {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 4) return 2;
  return 3;
}

/** A key that changes when the album's membership does, so React does not
 * reuse a grid across a regrouping. */
export function albumKey(messages) {
  return `album:${messages[0].id}:${messages.length}`;
}
