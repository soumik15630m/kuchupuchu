export const STALE_AFTER_MS: number;
export const AUTO_INTERVAL_MS: number;

export function isStale(lastVerifiedAtMs: number | null | undefined, nowMs: number): boolean;
export function shouldRunAutomatically(
  state: {
    hasStoredPassphrase: boolean;
    lastVerifiedAtMs: number | null;
    lastAttemptAtMs: number | null;
  },
  nowMs: number,
  options?: { online?: boolean }
): boolean;
export function inspectManifest(
  manifest: unknown,
  expectedEmail: string
): {
  ok: boolean;
  problems: string[];
  counts:
    | { messages: number; groups: number; includesMedia: boolean; createdAtMs: number | null }
    | null;
};
export function checkMedia(
  manifest: unknown,
  blobIds: string[]
): { expected: number; present: number; missing: number };
export function describeResult(
  result:
    | {
        ok: boolean;
        problems: string[];
        verifiedAtMs: number;
        counts?: { messages: number } | null;
        media?: { expected: number; present: number; missing: number } | null;
      }
    | null,
  nowMs: number,
  formatDate: (ms: number) => string
): string;
