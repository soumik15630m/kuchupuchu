import type { StoredMessage } from "../messaging/store";

export function formatStamp(ms: number): string;
export function mediaFilename(message: StoredMessage): string;
export function formatTranscript(
  messages: StoredMessage[],
  options: {
    chatName: string;
    nameFor: (email: string) => string;
    describe: (message: StoredMessage) => string;
    includeMedia?: boolean;
    selfLabel?: string;
    exportedAtMs?: number;
  }
): string;
export function transcriptFilename(chatName: string, exportedAtMs?: number): string;
