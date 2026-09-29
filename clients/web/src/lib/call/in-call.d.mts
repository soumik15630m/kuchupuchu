export const IN_CALL_TOPIC: string;
export const MAX_CHAT_LENGTH: number;
export const MAX_CHAT_HISTORY: number;
export const HAND_TIMEOUT_MS: number;

export type InCallFrame = { t: "hand"; up: boolean } | { t: "chat"; body: string };

export interface ChatEntry {
  from: string;
  body: string;
  atMs: number;
  mine: boolean;
}

export function encodeFrame(frame: InCallFrame): Uint8Array;
export function decodeFrame(payload: Uint8Array): InCallFrame | null;
export function appendChat(history: ChatEntry[], entry: ChatEntry): ChatEntry[];
export function applyHand(
  hands: Record<string, number>,
  identity: string,
  up: boolean,
  nowMs: number
): Record<string, number>;
export function pruneHands(
  hands: Record<string, number>,
  presentIdentities: string[],
  nowMs: number
): Record<string, number>;
export function handOrder(hands: Record<string, number>): string[];
export function mainSpeaker<T extends { identity: string; isLocal?: boolean }>(
  participants: T[],
  pinnedIdentity: string | null,
  activeIdentity: string | null
): T | null;
export function togglePin(pinnedIdentity: string | null, identity: string): string | null;
export function prunePin(
  pinnedIdentity: string | null,
  presentIdentities: string[]
): string | null;
