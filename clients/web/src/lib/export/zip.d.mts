export function crc32(bytes: Uint8Array): number;
export function dosDateTime(date: Date): { time: number; date: number };
export function safeEntryName(name: string): string;
export function buildZip(entries: { name: string; bytes: Uint8Array; date?: Date }[]): Uint8Array;
