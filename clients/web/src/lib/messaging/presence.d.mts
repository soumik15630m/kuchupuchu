import type { PresenceEntry } from "./client";

export function presenceLabel(
  entry: PresenceEntry | null | undefined,
  nowMs: number,
  formatTime: (ms: number) => string,
  formatDate: (ms: number) => string
): string | null;
