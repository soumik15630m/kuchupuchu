import { deviceId } from "../api/client";

/** Everything this device stores about the signed-in member.
 *
 * Signing out deliberately leaves all of it alone: logging back in as the
 * same person must find the same chats, and the same device id means the same
 * ratchet state, so history is not re-requested from scratch. What is *not*
 * acceptable is a second member signing in on the same browser and inheriting
 * the first one's messages, which is what this wipes.
 */
const DATABASES = [
  "kuchupuchu-messages",
  "kuchupuchu-status",
  "kuchupuchu-avatars",
  "kuchupuchu-stickers",
  "kuchupuchu-wallpapers",
  "kuchupuchu-identity-pins",
];

const LOCAL_KEYS = [
  "kuchupuchu:groups",
  "kuchupuchu:chat-settings",
  "kuchupuchu:call-log",
  "kuchupuchu:history-asked",
  "kuchupuchu:app-lock",
  "kuchupuchu:unlocked-at",
  "kuchupuchu:notifications",
];

const OWNER_KEY = "kuchupuchu:local-owner";

/** Call before adopting a new session. Returns true if anything was cleared.
 *
 * The device id is minted fresh too: the identity key published under the old
 * one belongs to the previous member and is write-once server side, so reusing
 * it would try to publish a second identity for someone else's device.
 */
export async function claimLocalDataFor(email: string): Promise<boolean> {
  const owner = localStorage.getItem(OWNER_KEY);
  const next = email.toLowerCase();
  if (owner === next) return false;

  localStorage.setItem(OWNER_KEY, next);
  // First run on this browser: there is nothing of anyone else's to remove,
  // and wiping would throw away a session that just signed in.
  if (!owner) return false;

  for (const key of LOCAL_KEYS) localStorage.removeItem(key);
  localStorage.removeItem("kuchupuchu:device");
  // Re-mint immediately so the rest of sign-in sees a stable id.
  deviceId();

  await Promise.all(
    DATABASES.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          // A database still open in another tab blocks forever otherwise;
          // the next sign-in retries, and the owner key is already updated.
          req.onblocked = () => resolve();
        })
    )
  );
  return true;
}
