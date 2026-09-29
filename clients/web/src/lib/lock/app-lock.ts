/** Screen lock for the app itself.
 *
 * Scope, stated plainly: this protects against someone picking up an unlocked
 * device and reading the chat list. It does NOT encrypt anything at rest —
 * message history and ratchet state live in IndexedDB either way, and anyone
 * with real access to the machine's profile can read them regardless. Claiming
 * otherwise would be worse than not having the feature.
 *
 * The PIN is therefore verified, not used as a key: stored as a PBKDF2 hash
 * with a random salt so the stored value does not reveal the PIN, and the
 * iteration count is high enough that guessing a 4-6 digit PIN offline is slow
 * rather than instant.
 */

const KEY = "kuchupuchu:app-lock";
const ITERATIONS = 310_000;

export interface LockConfig {
  saltB64: string;
  hashB64: string;
  /** Milliseconds of inactivity before locking; 0 means immediately. */
  autoLockMs: number;
  failedAttempts: number;
  lockedOutUntilMs?: number;
  /** A platform authenticator registered as an alternative way through the
   * same gate. Additive: the PIN is never removed, because an unlock method
   * with no fallback is a way to lose a conversation. See webauthn.ts. */
  credentialIdB64?: string;
}

export const AUTO_LOCK_OPTIONS = [
  { label: "Immediately", ms: 0 },
  { label: "After 1 minute", ms: 60_000 },
  { label: "After 15 minutes", ms: 15 * 60_000 },
  { label: "After 1 hour", ms: 60 * 60_000 },
] as const;

/** Backs off after repeated wrong PINs, so the whole keyspace cannot be walked
 * by someone holding the device. */
const BACKOFF_AFTER = 5;
const BACKOFF_MS = 60_000;

function toB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    256
  );
  return toB64(bits);
}

export function loadLock(): LockConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LockConfig) : null;
  } catch {
    return null;
  }
}

function save(config: LockConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function isLockEnabled(): boolean {
  return loadLock() !== null;
}

export async function enableLock(pin: string, autoLockMs: number): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  save({
    saltB64: toB64(salt.buffer as ArrayBuffer),
    hashB64: await derive(pin, salt),
    autoLockMs,
    failedAttempts: 0,
  });
}

export function disableLock(): void {
  localStorage.removeItem(KEY);
}

export function setAutoLock(autoLockMs: number): void {
  const config = loadLock();
  if (config) save({ ...config, autoLockMs });
}

export interface VerifyResult {
  ok: boolean;
  /** Set when too many wrong attempts have locked further tries out. */
  lockedOutUntilMs?: number;
  attemptsRemaining?: number;
}

export async function verifyPin(pin: string): Promise<VerifyResult> {
  const config = loadLock();
  if (!config) return { ok: true };

  if (config.lockedOutUntilMs && config.lockedOutUntilMs > Date.now()) {
    return { ok: false, lockedOutUntilMs: config.lockedOutUntilMs };
  }

  const candidate = await derive(pin, fromB64(config.saltB64));
  // Constant-time-ish: compare the full strings rather than returning early,
  // so timing does not leak how many characters matched.
  let mismatch = candidate.length === config.hashB64.length ? 0 : 1;
  for (let i = 0; i < Math.min(candidate.length, config.hashB64.length); i++) {
    mismatch |= candidate.charCodeAt(i) ^ config.hashB64.charCodeAt(i);
  }

  if (mismatch === 0) {
    save({ ...config, failedAttempts: 0, lockedOutUntilMs: undefined });
    return { ok: true };
  }

  const failedAttempts = config.failedAttempts + 1;
  const lockedOutUntilMs =
    failedAttempts >= BACKOFF_AFTER ? Date.now() + BACKOFF_MS : undefined;
  save({ ...config, failedAttempts, lockedOutUntilMs });

  return {
    ok: false,
    lockedOutUntilMs,
    attemptsRemaining: Math.max(0, BACKOFF_AFTER - failedAttempts),
  };
}

const UNLOCKED_AT = "kuchupuchu:unlocked-at";

export function markUnlocked(): void {
  sessionStorage.setItem(UNLOCKED_AT, String(Date.now()));
}

export function clearUnlocked(): void {
  sessionStorage.removeItem(UNLOCKED_AT);
}

/** Whether the app should present the lock screen right now. */
export function shouldLock(nowMs = Date.now()): boolean {
  const config = loadLock();
  if (!config) return false;

  // sessionStorage, not localStorage: a new tab is a new session and should
  // ask again, which is the behaviour people expect from a lock.
  const unlockedAt = Number(sessionStorage.getItem(UNLOCKED_AT) ?? 0);
  if (!unlockedAt) return true;
  // 0 means "lock as soon as you leave", so it is the strictest option, not
  // an opt-out. Returning false here made it the *weakest* -- it only ever
  // locked on a new tab.
  if (config.autoLockMs === 0) return document.visibilityState !== "visible";
  return nowMs - unlockedAt > config.autoLockMs;
}

export function touchActivity(): void {
  if (sessionStorage.getItem(UNLOCKED_AT)) markUnlocked();
}

export function setUnlockCredential(credentialIdB64: string | null): void {
  const config = loadLock();
  if (!config) return;
  const next = { ...config };
  if (credentialIdB64) next.credentialIdB64 = credentialIdB64;
  else delete next.credentialIdB64;
  save(next);
}

export function unlockCredentialId(): string | null {
  return loadLock()?.credentialIdB64 ?? null;
}

/** Records a successful authenticator unlock.
 *
 * Deliberately resets the PIN backoff too: the member proved who they are,
 * and leaving them locked out of the PIN afterwards would punish the person
 * who just passed the stronger check. */
export function noteCredentialUnlock(): void {
  const config = loadLock();
  if (config) save({ ...config, failedAttempts: 0, lockedOutUntilMs: undefined });
}
