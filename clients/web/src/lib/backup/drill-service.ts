import type { Session } from "../api/client";
import { storedCredential } from "./credential";
import { checkMedia, inspectManifest } from "./drill.mjs";
import { openBackup, openBackupWithKey, readEnvelopeHeader } from "./envelope.mjs";
import { unpackArchive } from "./archive.mjs";

/** Proving the backup on the server can actually be restored.
 *
 * Nothing is written. The archive is downloaded, unsealed, unpacked and
 * inspected, and then thrown away -- so running a drill can never damage what
 * is already on the device, which is the reason it is safe to run
 * automatically.
 */

const KEY = "kuchupuchu:backup-drill";

export interface DrillResult {
  ok: boolean;
  problems: string[];
  verifiedAtMs: number;
  counts: { messages: number; groups: number; includesMedia: boolean; createdAtMs: number | null } | null;
  media: { expected: number; present: number; missing: number } | null;
  /** From the envelope header, so a member can see the archive really is
   * sealed with the iteration count this version uses. */
  kdfIterations?: number;
}

export interface DrillState {
  lastVerifiedAtMs: number | null;
  lastAttemptAtMs: number | null;
  hasStoredPassphrase: boolean;
  last: DrillResult | null;
}

export function loadDrillState(hasStoredPassphrase: boolean): DrillState {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<DrillState>) : null;
    return {
      lastVerifiedAtMs: parsed?.lastVerifiedAtMs ?? null,
      lastAttemptAtMs: parsed?.lastAttemptAtMs ?? null,
      last: parsed?.last ?? null,
      hasStoredPassphrase,
    };
  } catch {
    return { lastVerifiedAtMs: null, lastAttemptAtMs: null, last: null, hasStoredPassphrase };
  }
}

function saveDrillState(state: Omit<DrillState, "hasStoredPassphrase">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota; the result is still returned to the caller for this session.
  }
}

/** Runs the drill. `passphrase` is optional: without it the stored one is
 * used, and if there is none the drill reports that rather than prompting. */
export async function runDrill(
  session: Session,
  email: string,
  passphrase?: string
): Promise<DrillResult> {
  const attemptedAtMs = Date.now();
  const fail = (problem: string): DrillResult => {
    const result: DrillResult = {
      ok: false,
      problems: [problem],
      verifiedAtMs: attemptedAtMs,
      counts: null,
      media: null,
    };
    saveDrillState({
      lastVerifiedAtMs: loadDrillState(false).lastVerifiedAtMs,
      lastAttemptAtMs: attemptedAtMs,
      last: result,
    });
    return result;
  };

  // Either the passphrase the member just typed, or the key the scheduled
  // backup already holds. Never a passphrase recovered from storage: the
  // credential deliberately keeps a non-extractable key and nothing else.
  const stored = passphrase ? null : await storedCredential();
  if (!passphrase && !stored) {
    return fail("No passphrase is stored on this device, so this check needs yours.");
  }

  let sealed: Uint8Array;
  try {
    sealed = await session.downloadBackup();
  } catch {
    return fail("There is no backup on the server to check.");
  }

  let header: { iterations: number } | null = null;
  try {
    header = readEnvelopeHeader(sealed);
  } catch {
    return fail("The file on the server is not a Kuchupuchu backup.");
  }

  let archive: Uint8Array;
  try {
    archive = passphrase
      ? await openBackup(sealed, passphrase)
      : await openBackupWithKey(sealed, stored!.key);
  } catch {
    // The single most valuable thing this whole feature can catch.
    return fail("The passphrase did not open the backup.");
  }

  let manifest: unknown;
  let blobIds: string[];
  try {
    const unpacked = await unpackArchive(archive);
    manifest = unpacked.manifest;
    blobIds = [...unpacked.blobs.keys()];
  } catch {
    return fail("The backup decrypted but the archive inside it is damaged.");
  }

  const inspected = inspectManifest(manifest, email);
  const media = checkMedia(manifest, blobIds);
  const problems = [...inspected.problems];
  if (media.missing > 0) {
    problems.push(
      `${media.missing} of ${media.expected} attachments are not in the archive.`
    );
  }

  const result: DrillResult = {
    ok: problems.length === 0,
    problems,
    verifiedAtMs: attemptedAtMs,
    counts: inspected.counts,
    media,
    kdfIterations: header?.iterations,
  };

  saveDrillState({
    // Only a clean pass moves the "last verified" mark. A partial result
    // would otherwise let a backup missing half its photos read as verified.
    lastVerifiedAtMs: result.ok ? attemptedAtMs : loadDrillState(false).lastVerifiedAtMs,
    lastAttemptAtMs: attemptedAtMs,
    last: result,
  });
  return result;
}
