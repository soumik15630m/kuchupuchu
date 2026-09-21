import { deviceId } from "../api/client";

import { KUCHUPUCHU_DB_PREFIX, LOCAL_KEYS, decideLocalClaim } from "./local-claim.mjs";

/** Databases to remove when the browser changes hands.
 *
 * Only a fallback: the live path enumerates `indexedDB.databases()` and takes
 * everything with the app's prefix, because this list has already been wrong
 * once -- the identity and ratchet stores live in .js modules and were missed,
 * which would have left a new member holding the previous one's identity key.
 * Firefox has no `databases()`, hence the list survives. */
const KNOWN_DATABASES = [
  "kuchupuchu-messages",
  "kuchupuchu-status",
  "kuchupuchu-avatars",
  "kuchupuchu-stickers",
  "kuchupuchu-wallpapers",
  "kuchupuchu-identity-pins",
  "kuchupuchu-e2ee",
  "kuchupuchu-ratchets",
];

const OWNER_KEY = "kuchupuchu:local-owner";

/** Records who this browser's local data belongs to, without touching it.
 *
 * Called when an existing session is restored: an install that predates the
 * owner key has data but no owner, and stamping it here is what stops the
 * next sign-in reading that as "unknown, therefore wipe". */
export function noteLocalOwner(email: string): void {
  localStorage.setItem(OWNER_KEY, email.toLowerCase());
}

function hasExistingData(): boolean {
  if (localStorage.getItem("kuchupuchu:device")) return true;
  return LOCAL_KEYS.some((key) => localStorage.getItem(key) !== null);
}

/** Call before signing someone in. Returns true if local data was wiped.
 *
 * Signing out deliberately leaves everything alone, so the same member logging
 * back in finds the same chats and the same device id -- and therefore the
 * same ratchet state. What this stops is a *different* member inheriting them.
 */
export async function claimLocalDataFor(email: string): Promise<boolean> {
  const next = email.toLowerCase();
  const decision = decideLocalClaim({
    owner: localStorage.getItem(OWNER_KEY),
    next,
    hasData: hasExistingData(),
  });

  localStorage.setItem(OWNER_KEY, next);
  if (!decision.wipe) return false;

  for (const key of LOCAL_KEYS) localStorage.removeItem(key);
  // The identity key published under the old device id belongs to the previous
  // member and is write-once server side, so the id has to be re-minted rather
  // than reused.
  localStorage.removeItem("kuchupuchu:device");
  deviceId();

  await Promise.all((await databasesToDrop()).map(dropDatabase));
  return true;
}

async function databasesToDrop(): Promise<string[]> {
  try {
    if (!indexedDB.databases) return KNOWN_DATABASES;
    const found = await indexedDB.databases();
    const named = found
      .map((db) => db.name)
      .filter((name): name is string => Boolean(name?.startsWith(KUCHUPUCHU_DB_PREFIX)));
    return [...new Set([...named, ...KNOWN_DATABASES])];
  } catch {
    return KNOWN_DATABASES;
  }
}

function dropDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    // A database still open in another tab blocks indefinitely otherwise. The
    // owner key is already written, so the next sign-in retries the drop.
    req.onblocked = () => resolve();
  });
}
