export const KUCHUPUCHU_DB_PREFIX: string;
export const LOCAL_KEYS: string[];

export function decideLocalClaim(input: {
  owner: string | null;
  next: string;
  hasData: boolean;
}): { wipe: boolean; reason: string };
