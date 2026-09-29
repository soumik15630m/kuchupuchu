/** Unlocking with the device's own authenticator — Touch ID, Windows Hello,
 * an Android fingerprint.
 *
 * Read `app-lock.ts`'s note first, because the same scope applies and it is
 * the part that would be easy to oversell: this is a **gate**, not
 * encryption. Message history and ratchet state sit in IndexedDB either way,
 * and anyone with real access to the machine's profile can read them whether
 * or not a fingerprint was involved. What it buys is exactly what the PIN
 * buys — someone who picks up an unlocked device cannot read the chat list —
 * with a gesture people will actually use.
 *
 * Specifically NOT claimed: that the biometric protects the data. It does
 * not, and WebAuthn's PRF extension (which could derive a real key) is not
 * used here because its support is inconsistent enough that the feature
 * would silently be a gate on half the devices it ran on. Being one thing
 * everywhere beats being two things unpredictably.
 *
 * The PIN always remains. A platform authenticator can stop working for
 * reasons the member did not choose — a reset fingerprint enrolment, a moved
 * profile, a browser update — and an unlock method with no fallback is a way
 * to lose a conversation.
 */

const RP_NAME = "Kuchupuchu";

function toB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export function webauthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator?.credentials?.create === "function"
  );
}

/** Whether this device has something built in, as opposed to only supporting
 * a roaming security key. Asked before offering the option, because offering
 * "unlock with Touch ID" on a machine that will prompt for a USB key is a
 * worse experience than not offering it. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!webauthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Registers a credential for unlocking. Returns its id, to be stored with
 * the lock config; null if the member cancelled or it failed. */
export async function registerUnlockCredential(email: string): Promise<string | null> {
  if (!webauthnSupported()) return null;
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        // Random per registration. There is no server to check it against --
        // this is a local gate -- but a fixed challenge is the kind of thing
        // that becomes wrong the moment a server is added.
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME },
        user: {
          // Not the email: a stable random id per install, so the credential
          // stored in the authenticator does not carry the address around.
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: email,
          displayName: email,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256, for Windows Hello
        ],
        authenticatorSelection: {
          // Built in only: a roaming key that lives in a drawer is not an
          // unlock gesture.
          authenticatorAttachment: "platform",
          // The whole point. Without this the authenticator may assert
          // presence alone -- a tap -- which gates nothing.
          userVerification: "required",
          residentKey: "preferred",
        },
        // Nothing here verifies attestation, so asking for it would collect a
        // device identifier for no purpose.
        attestation: "none",
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;

    return credential ? toB64(credential.rawId) : null;
  } catch {
    return null;
  }
}

/** Prompts for the authenticator. True only on a verified assertion. */
export async function verifyWithCredential(credentialIdB64: string): Promise<boolean> {
  if (!webauthnSupported()) return false;
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          { type: "public-key", id: fromB64(credentialIdB64) as BufferSource },
        ],
        userVerification: "required",
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) return false;
    // The assertion signature is not checked: there is no stored public key
    // and no server, so there is nothing to check it against. What is being
    // relied on is that the browser only returns an assertion at all after
    // the platform verified the member -- which is the gate. Said out loud
    // because it is the one place this could be mistaken for cryptographic
    // proof, and it is not.
    const response = assertion.response as AuthenticatorAssertionResponse;
    // Bit 2 of the authenticator data flags is "user verified". A browser
    // that returned an assertion without it did not do what was asked.
    const flags = new Uint8Array(response.authenticatorData)[32];
    return (flags & 0x04) !== 0;
  } catch {
    return false;
  }
}
