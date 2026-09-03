// §6.1/§13 Phase 4: group call room-key rotation.
//
// Split deliberately into two pieces:
//   - This file: pure decision logic (who rotates, has the room
//     converged on one key or not). No network calls, no crypto, no
//     LiveKit -- which means it's the part that's actually practical to
//     unit test exhaustively, including the timing/tie-break edge cases
//     that are easy to get subtly wrong and hard to catch by eyeballing
//     a live call.
//   - group-e2ee.js: wires this logic to real X3DH sessions, the
//     transport chain, LiveKit's data channel, and the key provider.

/** Deterministically picks which participant is responsible for
 * generating and distributing the room key: earliest `joinedAtMs`,
 * ties broken by ascending identity string. `participants` must include
 * the local participant -- this returns whoever's turn it is, and the
 * caller compares that against its own identity to decide whether it's
 * "me". */
export function electRotator(participants) {
  if (participants.length === 0) {
    throw new Error("electRotator called with no participants -- caller should not invoke this before joining");
  }
  const sorted = [...participants].sort((a, b) => {
    if (a.joinedAtMs !== b.joinedAtMs) return a.joinedAtMs - b.joinedAtMs;
    return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
  });
  return sorted[0].identity;
}

// §6.1's stated threshold: "on a >50% mismatch, one silent auto-re-
// rotation, then an explicit rejoin prompt if it still disagrees."
const MISMATCH_RETRY_THRESHOLD = 0.5;

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
