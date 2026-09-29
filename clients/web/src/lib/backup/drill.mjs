/** The rules for "is that backup actually restorable?"
 *
 * A backup nobody has ever restored is a hope, not a backup. The failure is
 * always the same shape: it looked fine for months and then the one time it
 * mattered the passphrase was wrong, or the upload was truncated, or the
 * archive was written by a version that no longer reads.
 *
 * The drill answers that without touching this device's data: download,
 * unseal, unpack, check the manifest. Nothing is written. Pure helpers here so
 * the reporting and the staleness rule can be tested without a server.
 */

const DAY = 24 * 60 * 60 * 1000;

/** How long a verification stays meaningful. A week matches the daily-backup
 * cadence closely enough that a single failed night does not raise an alarm,
 * and tightly enough that "verified" never means "sometime last quarter". */
export const STALE_AFTER_MS = 7 * DAY;

/** Run one automatically at most this often. The drill downloads and decrypts
 * the whole archive; doing that on every app start would spend the member's
 * bandwidth to tell them something they were told an hour ago. */
export const AUTO_INTERVAL_MS = 3 * DAY;

export function isStale(lastVerifiedAtMs, nowMs) {
  if (!lastVerifiedAtMs) return true;
  return nowMs - lastVerifiedAtMs > STALE_AFTER_MS;
}

export function shouldRunAutomatically(state, nowMs, { online = true } = {}) {
  if (!online) return false;
  // Never when there is no stored passphrase: the drill is not worth
  // interrupting someone to type one, and a prompt they did not ask for
  // reads as the app losing their backup.
  if (!state.hasStoredPassphrase) return false;
  if (state.lastAttemptAtMs && nowMs - state.lastAttemptAtMs < AUTO_INTERVAL_MS) return false;
  return isStale(state.lastVerifiedAtMs, nowMs);
}

/** Checks a decrypted manifest is the shape a restore needs.
 *
 * Deliberately strict about `email`: an archive belonging to someone else
 * would restore another member's history onto this device, and the one moment
 * to catch that is before anything is written.
 */
export function inspectManifest(manifest, expectedEmail) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, problems: ["The archive did not contain a manifest."], counts: null };
  }

  if (typeof manifest.email !== "string" || !manifest.email) {
    problems.push("The archive does not say whose it is.");
  } else if (expectedEmail && manifest.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    problems.push(`The archive belongs to ${manifest.email}, not this account.`);
  }

  if (!Number.isFinite(manifest.createdAtMs) || manifest.createdAtMs <= 0) {
    problems.push("The archive has no usable creation time.");
  }
  if (!Array.isArray(manifest.messages)) {
    problems.push("The archive has no message list.");
  }
  if (!Array.isArray(manifest.groups)) {
    problems.push("The archive has no group list.");
  }

  const counts = {
    messages: Array.isArray(manifest.messages) ? manifest.messages.length : 0,
    groups: Array.isArray(manifest.groups) ? manifest.groups.length : 0,
    includesMedia: manifest.includesMedia === true,
    createdAtMs: Number.isFinite(manifest.createdAtMs) ? manifest.createdAtMs : null,
  };

  return { ok: problems.length === 0, problems, counts };
}

/** Whether every message that claims an attachment has its bytes in the
 * archive. A backup that restores the text and loses the photos is a partial
 * backup, and the member should hear that from the drill rather than from a
 * restore. */
export function checkMedia(manifest, blobIds) {
  if (!manifest?.includesMedia) return { expected: 0, present: 0, missing: 0 };
  const present = new Set(blobIds);
  const wanted = (manifest.messages ?? [])
    .map((m) => m.media?.mediaId)
    .filter((id) => typeof id === "string");
  const unique = [...new Set(wanted)];
  const missing = unique.filter((id) => !present.has(id));
  return { expected: unique.length, present: unique.length - missing.length, missing: missing.length };
}

/** The single line the settings row shows. */
export function describeResult(result, nowMs, formatDate) {
  if (!result) return "Never checked.";
  if (!result.ok) return `Last check failed: ${result.problems[0] ?? "unknown reason"}`;

  const age = nowMs - result.verifiedAtMs;
  const when = age < DAY ? "today" : age < 2 * DAY ? "yesterday" : formatDate(result.verifiedAtMs);
  const media =
    result.media && result.media.expected > 0
      ? `, ${result.media.present} of ${result.media.expected} attachments`
      : "";
  return `Restored a copy ${when}: ${result.counts.messages} messages${media}.`;
}
