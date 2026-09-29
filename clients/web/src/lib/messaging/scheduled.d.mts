import type { ScheduledMessage } from "./scheduled-store";

export const MAX_AHEAD_MS: number;
export const MIN_AHEAD_MS: number;

export function presets(nowMs: number): { label: string; atMs: number }[];
export function validate(atMs: number, nowMs: number): string | null;
export function add<T extends { atMs: number }>(queue: T[], entry: T): T[];
export function remove<T extends { id: string }>(queue: T[], id: string): T[];
export function due<T extends { atMs: number }>(queue: T[], nowMs: number): T[];
export function pending<T extends { atMs: number }>(queue: T[], nowMs: number): T[];
export function forChat<T extends { chatId: string }>(queue: T[], chatId: string): T[];
export function nextDelayMs(
  queue: { atMs: number }[],
  nowMs: number,
  options?: { min?: number; max?: number }
): number | null;
export function describeWhen(
  atMs: number,
  nowMs: number,
  formatTime: (ms: number) => string,
  formatDate: (ms: number) => string
): string;
export function lateBy(entry: Pick<ScheduledMessage, "atMs">, sentAtMs: number): string | null;
