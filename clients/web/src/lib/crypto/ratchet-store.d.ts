export function sessionKey(peerEmail: string, peerDeviceId: string): string;
export function loadRatchetState(key: string): Promise<unknown | null>;
export function saveRatchetState(key: string, state: unknown): Promise<boolean>;
export function deleteRatchetState(key: string): Promise<void>;
export function listSessionKeys(): Promise<string[]>;
