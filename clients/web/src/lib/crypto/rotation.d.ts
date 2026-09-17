export interface RotationParticipant {
  identity: string;
  joinedAtMs: number | null | undefined;
}

export type ConvergenceAction = "wait" | "converged" | "retry-rotation" | "prompt-rejoin";

export function electRotator(participants: RotationParticipant[]): string;

export class FingerprintConvergence {
  constructor(generation: number, expectedPeerCount: number);
  generation: number;
  expectedPeerCount: number;
  ownFingerprint: string | null;
  peerFingerprints: Map<string, string>;
  retriedOnce: boolean;
  setOwnFingerprint(fp: string): void;
  recordPeerFingerprint(identity: string, fp: string): void;
  mismatchFraction(): number;
  haveHeardFromEveryone(): boolean;
  decide(): { action: ConvergenceAction };
}
