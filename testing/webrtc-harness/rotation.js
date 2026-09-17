// §6.1/§13 Phase 4: group call room-key rotation.
//
// Pure decision logic -- no network, crypto or LiveKit -- so the
// timing and tie-break cases are practical to unit test exhaustively.
// group-e2ee.js wires it to real sessions and the data channel.

/** Deterministically picks which participant is responsible for
 * generating and distributing the room key: earliest `joinedAtMs`,
 * ties broken by ascending identity string. `participants` must include
 * the local participant -- this returns whoever's turn it is, and the
 * caller compares that against its own identity to decide whether it's
 * "me".
 *
 * A null/undefined `joinedAtMs` (LiveKit hasn't populated `joinedAt` for
 * that participant yet) sorts LAST, not first. The caller used to
 * substitute 0, which is the worst possible choice: 0 is earlier than
 * every real timestamp, so the one participant whose join time hadn't
 * arrived yet would win the election outright, and two clients
 * disagreeing about whose timestamp is known would each elect a
 * different rotator and both start minting room keys. Sorting unknowns
 * last means an unknown join time can only ever lose to a known one,
 * and if every participant's is unknown the identity tie-break still
 * gives every client the same answer. */
export function electRotator(participants) {
  if (participants.length === 0) {
    throw new Error("electRotator called with no participants -- caller should not invoke this before joining");
  }
  const rank = (p) => (p.joinedAtMs === null || p.joinedAtMs === undefined ? Infinity : p.joinedAtMs);
  const sorted = [...participants].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
  });
  return sorted[0].identity;
}

// §6.1 states the threshold as ">50% mismatch". Taken literally that
// means an even split reports success: in a 4-way call, two peers on a
// different key is exactly 0.5, and half the room cannot decrypt the
// other half. The majority framing is right for deciding who the odd
// one out is, wrong for deciding whether anything is wrong at all --
// so any disagreement triggers the retry-then-prompt sequence.
const MISMATCH_RETRY_THRESHOLD = 0;

/** Tracks fingerprint agreement for one room-key generation across the
 * other participants in the call, and decides what §6.1's retry policy
 * says to do about it. One instance covers exactly one generation --
 * group-e2ee.js creates a fresh one each time it rotates. */
export class FingerprintConvergence {
  constructor(generation, expectedPeerCount) {
    this.generation = generation;
    this.expectedPeerCount = expectedPeerCount;
    this.ownFingerprint = null;
    this.peerFingerprints = new Map(); // identity -> fingerprint
    this.retriedOnce = false;
  }

  setOwnFingerprint(fp) {
    this.ownFingerprint = fp;
  }

  recordPeerFingerprint(identity, fp) {
    this.peerFingerprints.set(identity, fp);
  }

  /** Fraction of expected peers whose reported fingerprint disagrees
   * with ours, out of everyone we've heard from so far. Returns 0 if we
   * don't have our own fingerprint yet or haven't heard from anyone --
   * "no evidence of disagreement" is the correct default, not "assume
   * the worst". */
  mismatchFraction() {
    if (this.ownFingerprint === null || this.peerFingerprints.size === 0) return 0;
    let mismatched = 0;
    for (const fp of this.peerFingerprints.values()) {
      if (fp !== this.ownFingerprint) mismatched++;
    }
    return mismatched / this.peerFingerprints.size;
  }

  /** Have we heard from every peer we expect to, for this generation?
   * Deciding to retry/prompt before everyone's checked in would be
   * reacting to a partial, possibly-stale picture. */
  haveHeardFromEveryone() {
    return this.peerFingerprints.size >= this.expectedPeerCount;
  }

  /** What group-e2ee.js should do right now, given everything recorded
   * so far. Only meaningful once `haveHeardFromEveryone()` -- calling it
   * earlier just returns "keep waiting", which is the safe default. */
  decide() {
    if (!this.haveHeardFromEveryone()) return { action: "wait" };

    const mismatch = this.mismatchFraction();
    if (mismatch <= MISMATCH_RETRY_THRESHOLD) return { action: "converged" };

    if (!this.retriedOnce) {
      this.retriedOnce = true;
      return { action: "retry-rotation" };
    }
    return { action: "prompt-rejoin" };
  }
}
