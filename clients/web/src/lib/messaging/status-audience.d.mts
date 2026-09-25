export interface StatusAudience {
  mode: "all" | "only";
  except: string[];
  only: string[];
}

export const STATUS_AUDIENCE_KEY: string;

export function defaultStatusAudience(): StatusAudience;
export function normaliseStatusAudience(raw: unknown): StatusAudience;
export function loadStatusAudience(storage?: Storage | null): StatusAudience;
export function saveStatusAudience(
  patch: Partial<StatusAudience>,
  storage?: Storage
): StatusAudience;
export function statusRecipients(settings: StatusAudience, everyone: string[]): string[];
export function describeStatusAudience(settings: StatusAudience, everyone: string[]): string;
