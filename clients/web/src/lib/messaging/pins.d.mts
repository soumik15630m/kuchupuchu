import type { StoredMessage } from "./store";

export const MAX_PINS: number;

export function addPin(pinned: string[], id: string): string[];
export function removePin(pinned: string[], id: string): string[];
export function isPinned(pinned: string[], id: string): boolean;
export function applyPinChange(pinned: string[], id: string, pin: boolean): string[];
export function prunePins(pinned: string[], existingIds: string[]): string[];
export function pinnedMessages(pinned: string[], messages: StoredMessage[]): StoredMessage[];
