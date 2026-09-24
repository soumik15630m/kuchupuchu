import { deviceId } from "../api/client";
import { closeStore } from "../idb";

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
  "kuchupuchu-media-cache",
  "kuchupuchu-backup-key",
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

/** Throws away this browser's device identity and mints a new one.
 *
 * A revoked device id can never be reused -- the server says so and is right
 * to -- which left a member whose device had been revoked permanently stuck
 * on the login screen, reading an error telling them to do something the app
 * gave them no way to do. The ratchet state tied to the old identity is gone
 * either way, so it goes too; history comes back from a backup or from
 * another device.
 */
export async function resetDeviceIdentity(): Promise<string> {
  localStorage.removeItem("kuchupuchu:device");
  const fresh = deviceId();
  await Promise.all(
    ["kuchupuchu-e2ee", "kuchupuchu-ratchets"].map(dropDatabase)
  );
  return fresh;
}

/** Whether signing `email` in would replace whoever owns this browser's data.
 *
 * Read-only on purpose. This used to wipe as its first act, before the code
 * was ever checked -- and `/otp/request` answers 202 for every address by
 * design, so a single mistyped character walked straight into the code step
 * and destroyed every message, group and ratchet on the device without anyone
 * authenticating. Deciding and destroying are now separate steps, with a
 * successful sign-in in between.
 */
export function needsLocalWipe(email: string): boolean {
  return decideLocalClaim({
    owner: localStorage.getItem(OWNER_KEY),
    next: email.toLowerCase(),
    hasData: hasExistingData(),
  }).wipe;
}

/** A device id for an as-yet-unproven sign-in.
 *
 * Deliberately not persisted: the caller registers it with the server and
 * stores it only once the code checks out. Re-minting the stored id up front
 * would strand the old one's write-once identity key even when the sign-in
 * turns out to be a typo.
 */
export function provisionalDeviceId(): string {
  return `web-${crypto.randomUUID()}`;
}

/** Hands this browser to `email`, after they have proved who they are.
 *
 * Signing out deliberately leaves everything alone, so the same member logging
 * back in finds the same chats and the same device id -- and therefore the
 * same ratchet state. What this clears is a *different* member's data.
 */
export async function commitLocalClaim(
  email: string,
  options: { wipe: boolean; deviceId?: string }
): Promise<void> {
  localStorage.setItem(OWNER_KEY, email.toLowerCase());
  if (options.deviceId) localStorage.setItem("kuchupuchu:device", options.deviceId);
  if (!options.wipe) return;

  for (const key of LOCAL_KEYS) localStorage.removeItem(key);
  await Promise.all((await databasesToDrop()).map(dropDatabase));
  // The device id is written again because the wipe above does not touch it
  // and a re-run must not leave the browser without one.
  if (options.deviceId) localStorage.setItem("kuchupuchu:device", options.deviceId);
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
  // Connections are cached and held open, and deleteDatabase blocks for as
  // long as any connection exists -- so the handle has to go first or the
  // wipe silently does nothing.
  closeStore(name);
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    // A database still open in another tab blocks indefinitely otherwise. The
    // owner key is already written, so the next sign-in retries the drop.
    req.onblocked = () => resolve();
  });
}
