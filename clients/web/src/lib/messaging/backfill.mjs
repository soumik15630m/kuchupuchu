/** Asking this account's other devices for an attachment this one is missing.
 *
 * A newly linked device gets the history over the pairwise channel already,
 * but history is text: the blobs it refers to live in the media store, and
 * that store has a retention window. Past it, the message is here and the
 * photo is a broken square forever, even though the phone that sent it still
 * has the bytes.
 *
 * The answer is not to put bytes in an envelope -- a photo is megabytes and
 * the server rejects an envelope that size. The device that *has* it
 * re-encrypts and re-uploads it, then sends back a fresh reference. That
 * reuses the ordinary encrypted-blob path, so the server still only ever sees
 * ciphertext it cannot read, and the requesting device fetches it the same way
 * it fetches anything else.
 *
 * Rules here, pure, because the throttling is what stops this becoming a
 * storm: several devices answering the same request would each upload the same
 * photo, and a device scrolling through a year of history would ask for
 * hundreds at once.
 */

/** How long before the same attachment may be asked for again. Long enough
 * that scrolling past a missing photo repeatedly does not re-ask, short enough
 * that a device which was offline when asked gets another chance. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** At most this many outstanding at once. A device opening a long history
 * would otherwise ask for every missing blob in it before any answer arrived. */
export const MAX_IN_FLIGHT = 4;

export function needsBackfill(message) {
  if (!message?.media?.mediaId) return false;
  // A view-once photo that was opened is *supposed* to be gone. Asking a
  // sibling device to send it back would undo the one guarantee it had.
  if (message.viewOnce && message.viewedOnceAtMs) return false;
  if (message.deletedForEveryone) return false;
  return true;
}

/** Which of `candidates` may be asked for now.
 *
 * `asked` maps mediaId to when it was last requested. Returns at most
 * MAX_IN_FLIGHT, oldest message first -- someone who scrolled back is looking
 * at the old ones, so those are the ones worth the bandwidth.
 */
export function selectToRequest(candidates, asked, nowMs) {
  return candidates
    .filter(needsBackfill)
    .filter((m) => {
      const last = asked[m.media.mediaId];
      return !last || nowMs - last >= RETRY_AFTER_MS;
    })
    .sort((a, b) => a.sentAtMs - b.sentAtMs)
    .slice(0, MAX_IN_FLIGHT);
}

export function noteAsked(asked, mediaId, nowMs) {
  return { ...asked, [mediaId]: nowMs };
}

/** Drops entries old enough that they will never block a request again, so
 * the record does not grow forever on a long-lived install. */
export function pruneAsked(asked, nowMs) {
  const out = {};
  for (const [id, at] of Object.entries(asked)) {
    if (nowMs - at < RETRY_AFTER_MS) out[id] = at;
  }
  return out;
}

/** Whether this device should answer a request.
 *
 * Only for its own account, and only if it actually holds the bytes. The
 * `hasBlob` check is what keeps three devices from all uploading: two of them
 * do not have it cached and say nothing.
 */
export function shouldAnswer(request, selfEmail, fromEmail, hasBlob) {
  if (!request?.target) return false;
  if (fromEmail.toLowerCase() !== selfEmail.toLowerCase()) return false;
  return hasBlob;
}

/** Whether an incoming backfill is one this device asked for and can use. */
export function acceptBackfill(content, selfEmail, fromEmail, asked) {
  if (!content?.target || !content.media) return false;
  if (fromEmail.toLowerCase() !== selfEmail.toLowerCase()) return false;
  // Unrequested: a device that never asked should not have a message's media
  // reference rewritten by a sibling.
  return Object.prototype.hasOwnProperty.call(asked, content.target);
}
