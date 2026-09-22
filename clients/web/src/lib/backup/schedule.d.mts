export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";

export interface BackupSettings {
  frequency: BackupFrequency;
  includeMedia: boolean;
  lastSuccessMs: number | null;
  lastAttemptMs: number | null;
  lastError: string | null;
  runningSinceMs: number | null;
}

export const FREQUENCIES: readonly BackupFrequency[];
export const RETRY_AFTER_MS: number;
export const STALE_RUN_MS: number;

export function defaultSettings(): BackupSettings;
export function intervalFor(frequency: BackupFrequency): number | null;
export function nextRunAtMs(settings: BackupSettings, nowMs: number): number | null;
export function isDue(settings: BackupSettings, nowMs: number): boolean;
export function normaliseSettings(raw: unknown): BackupSettings;
