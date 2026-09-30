import type { StoredMessage } from "./store";

export const EPHEMERAL_DURATIONS: { label: string; ms: number }[];
export const EDIT_WINDOW_MS: number;

export function isKnownDuration(ms: number): boolean;
export function describeDuration(ms: number): string;
export function expiryFor(sentAtMs: number, durationMs: number | undefined): number | undefined;
export function isExpired(message: Pick<StoredMessage, "expiresAtMs">, nowMs: number): boolean;
export function expiredAmong<T extends Pick<StoredMessage, "expiresAtMs">>(
  messages: T[],
  nowMs: number
): T[];
export function nextSweepDelayMs(
  messages: Pick<StoredMessage, "expiresAtMs">[],
  nowMs: number,
  options?: { min?: number; max?: number }
): number | null;
export function canEdit(
  message: Pick<
    StoredMessage,
    "outgoing" | "fromEmail" | "deletedForEveryone" | "kind" | "sentAtMs"
  >,
  nowMs: number,
  selfEmail: string
): boolean;
export function timerNotice(actorName: string, durationMs: number): string;
