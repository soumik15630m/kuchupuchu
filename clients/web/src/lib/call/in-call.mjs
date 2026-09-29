/** The little side-channel inside a call: raised hands and typed messages.
 *
 * These travel on LiveKit's data channel, which is inside the same E2EE
 * envelope as the media -- so a message sent during a call is no more visible
 * to the SFU than the audio is. That is the reason to do it here rather than
 * reusing the messaging service: a call is already a live encrypted session
 * between exactly these people, and routing a "can you hear me?" through
 * store-and-forward would leave it in the chat afterwards.
 *
 * Which also decides the retention rule below: none. In-call chat lives for
 * the call. Nothing is written to the message store, because someone typing
 * during a call has not chosen to put it in the history.
 */

/** Separate from the E2EE key-exchange topic so a malformed chat frame can
 * never be fed to the crypto handler. */
export const IN_CALL_TOPIC = "kuchupuchu-in-call";

export const MAX_CHAT_LENGTH = 500;
/** Kept in memory only, and capped: a long call should not accumulate an
 * unbounded transcript in a tab. */
export const MAX_CHAT_HISTORY = 100;
/** A raised hand goes down on its own. Someone who forgets leaves a stale
 * hand up for the rest of the call, which stops the signal meaning anything. */
export const HAND_TIMEOUT_MS = 5 * 60 * 1000;

export function encodeFrame(frame) {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** Returns null for anything that is not a frame this version understands.
 * Parsed defensively because it arrives from another participant. */
export function decodeFrame(payload) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.t === "hand") return { t: "hand", up: parsed.up === true };
    if (parsed.t === "chat") {
      const body = typeof parsed.body === "string" ? parsed.body.slice(0, MAX_CHAT_LENGTH) : "";
      return body ? { t: "chat", body } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function appendChat(history, entry) {
  return [...history, entry].slice(-MAX_CHAT_HISTORY);
}

export function applyHand(hands, identity, up, nowMs) {
  const next = { ...hands };
  if (up) next[identity] = nowMs;
  else delete next[identity];
  return next;
}

/** Drops hands that have been up past the timeout, and hands belonging to
 * participants who have left -- a hand with nobody behind it is noise. */
export function pruneHands(hands, presentIdentities, nowMs) {
  const present = new Set(presentIdentities);
  const out = {};
  for (const [identity, raisedAt] of Object.entries(hands)) {
    if (!present.has(identity)) continue;
    if (nowMs - raisedAt >= HAND_TIMEOUT_MS) continue;
    out[identity] = raisedAt;
  }
  return out;
}

/** Order hands were raised in, which is the only useful order for them. */
export function handOrder(hands) {
  return Object.entries(hands)
    .sort((a, b) => a[1] - b[1])
    .map(([identity]) => identity);
}

/** Who fills the big tile.
 *
 * A manual pin always wins: someone who pinned a participant did so because
 * the automatic choice was wrong for them. Otherwise the active speaker, and
 * failing that whoever is first — never nobody, because an empty main tile
 * reads as a broken call.
 */
export function mainSpeaker(participants, pinnedIdentity, activeIdentity) {
  if (participants.length === 0) return null;
  const byIdentity = new Map(participants.map((p) => [p.identity, p]));
  if (pinnedIdentity && byIdentity.has(pinnedIdentity)) return byIdentity.get(pinnedIdentity);
  if (activeIdentity && byIdentity.has(activeIdentity)) return byIdentity.get(activeIdentity);
  const remote = participants.find((p) => !p.isLocal);
  return remote ?? participants[0];
}

/** Toggling: pinning the already-pinned participant unpins. Without this the
 * only way back to automatic is a separate control nobody finds. */
export function togglePin(pinnedIdentity, identity) {
  return pinnedIdentity === identity ? null : identity;
}

/** A pin whose participant has left is dropped, so the main tile does not
 * stay stuck on someone who hung up. */
export function prunePin(pinnedIdentity, presentIdentities) {
  if (!pinnedIdentity) return null;
  return presentIdentities.includes(pinnedIdentity) ? pinnedIdentity : null;
}
