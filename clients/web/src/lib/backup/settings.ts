import { normaliseSettings, type BackupSettings } from "./schedule.mjs";

const KEY = "kuchupuchu:backup-schedule";

export function loadBackupSettings(): BackupSettings {
  if (typeof localStorage === "undefined") return normaliseSettings(null);
  try {
    return normaliseSettings(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return normaliseSettings(null);
  }
}

export function saveBackupSettings(next: Partial<BackupSettings>): BackupSettings {
  const merged = normaliseSettings({ ...loadBackupSettings(), ...next });
  localStorage.setItem(KEY, JSON.stringify(merged));
  return merged;
}

export type { BackupSettings };
