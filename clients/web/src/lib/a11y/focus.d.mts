export const FOCUSABLE_SELECTOR: string;
export function nextTrapIndex(
  current: number,
  total: number,
  options?: { shift?: boolean }
): number;
export function nextListIndex(current: number, total: number, direction: 1 | -1): number;
export function isSearchShortcut(event: KeyboardEvent | null): boolean;
export function isTypingTarget(target: EventTarget | null): boolean;
