import type { StoredMessage } from "../messaging/store";

export const COALESCE_MS: number;
export function announceMessage(
  message: StoredMessage | null,
  nameFor: (email: string) => string,
  options?: { mentionsYou?: boolean }
): string | null;
export function coalesce(pending: number, single: string | null): string | null;
