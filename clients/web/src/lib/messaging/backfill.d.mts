import type { StoredMessage } from "./store";

export const RETRY_AFTER_MS: number;
export const MAX_IN_FLIGHT: number;

export function needsBackfill(message: StoredMessage | null | undefined): boolean;
export function selectToRequest(
  candidates: StoredMessage[],
  asked: Record<string, number>,
  nowMs: number
): StoredMessage[];
export function noteAsked(
  asked: Record<string, number>,
  mediaId: string,
  nowMs: number
): Record<string, number>;
export function pruneAsked(asked: Record<string, number>, nowMs: number): Record<string, number>;
export function shouldAnswer(
  request: { target?: string } | null,
  selfEmail: string,
  fromEmail: string,
  hasBlob: boolean
): boolean;
export function acceptBackfill(
  content: { target?: string; media?: unknown } | null,
  selfEmail: string,
  fromEmail: string,
  asked: Record<string, number>
): boolean;
