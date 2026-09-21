export const TYPING_EXPIRY_MS: number;

export interface TypingEntry {
  email: string;
  expiresAtMs: number;
}

export type TypingState = Map<string, TypingEntry[]>;

export function emptyTyping(): TypingState;

export function applyTyping(
  state: TypingState,
  event: { chatId: string; fromEmail: string; stopped: boolean },
  nowMs: number
): TypingState;

export function pruneTyping(state: TypingState, nowMs: number): TypingState;

export function typistsIn(state: TypingState, chatId: string, nowMs: number): string[];

export function typingLabel(names: string[], isGroup: boolean): string | null;
