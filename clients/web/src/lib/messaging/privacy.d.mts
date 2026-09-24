export interface SharingSettings {
  readReceipts: boolean;
  typing: boolean;
  lastSeen: boolean;
}

export const SHARING_KEY: string;

export function defaultSharing(): SharingSettings;
export function normaliseSharing(raw: unknown): SharingSettings;
export function loadSharing(storage?: Storage | null): SharingSettings;
export function saveSharing(patch: Partial<SharingSettings>, storage?: Storage): SharingSettings;
export function shouldSendReadReceipt(sharing: SharingSettings): boolean;
export function shouldShowReadReceipt(sharing: SharingSettings): boolean;
export function shouldSendTyping(sharing: SharingSettings): boolean;
export function shouldShowTyping(sharing: SharingSettings): boolean;
