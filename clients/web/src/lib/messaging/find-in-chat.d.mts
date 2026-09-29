import type { StoredMessage } from "./store";

export function matchIndices(
  messages: StoredMessage[],
  query: string,
  describe: (message: StoredMessage) => string
): number[];
export function step(cursor: number, total: number, direction: 1 | -1): number;
export function initialCursor(total: number): number;
export function describeProgress(cursor: number, total: number): string;
export function highlightParts(text: string, query: string): { text: string; match: boolean }[];
