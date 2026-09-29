import type { StoredMessage } from "./store";

export const ALBUM_GAP_MS: number;
export const ALBUM_MAX: number;

export type GroupedRow =
  | { type: "message"; message: StoredMessage }
  | { type: "album"; messages: StoredMessage[] };

export function groupIntoAlbums(messages: StoredMessage[]): GroupedRow[];
export function albumColumns(count: number): number;
export function albumKey(messages: StoredMessage[]): string;
