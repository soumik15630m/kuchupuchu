// Phase 4 done-bar exercise against a REAL running stack.
//
// Run with the stack up (docker compose up -d) and a valid access token
// per device:
//
//   NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
//     node test/phase4-gate.mjs
//
// What this covers that test/group-e2ee.test.mjs does not: every prekey
// operation goes to the real auth-service over real HTTPS -- publish,
// bundle fetch (which consumes a one-time prekey), and the non-consuming
// identity lookup used to verify inbound X3DH initial messages. The unit
// tests stub all of that with an in-memory fake server.
//
// What it still does NOT cover, and why this is not the whole done-bar:
// LiveKit's frame cryptor. That needs a real browser with a real
// RTCPeerConnection, so the SFrame encrypt/decrypt path and the
// room-key -> LiveKit key-provider handoff are exercised by
// testing/webrtc-harness/ in a browser, not here. This checks the layer
// that decides WHICH key everyone should be using and whether they all
// agree on it -- §6.1's fingerprint -- end to end against the server.
import assert from "node:assert/strict";

import { GroupE2EE } from "../group-e2ee.js";
import { fingerprint } from "../double-ratchet.js";

const API = process.env.API_BASE ?? "https://app.127.0.0.1.nip.io";
const DEVICES = ["dev-a", "dev-b", "dev-c"];
const EMAIL = Object.fromEntries(DEVICES.map((d) => [d, `${d.slice(-1)}@example.com`]));

const tokens = JSON.parse(process.env.TOKENS_JSON);

/** A stand-in for LiveKit's key provider: records what it was handed,
 *  and asserts the contract the real one requires. */
class RecordingKeyProvider {
  constructor(identity) {
    this.identity = identity;
    this.applied = [];
  }
  async applyRoomKey(keyBytes, generation, participantIdentities = []) {
    // The real GroupKeyProvider imports these bytes as HKDF material
    // before handing them to LiveKit. Assert the shape it depends on.
    assert.ok(keyBytes instanceof Uint8Array, "room key must be raw bytes here");
    assert.equal(keyBytes.length, 32, "room key must be 256-bit");
    assert.ok(
      participantIdentities.includes(this.identity),
      "own identity must be included — LiveKit's local encoder looks its key up by it"
    );
    this.applied.push({ key: Buffer.from(keyBytes).toString("hex"), generation, participantIdentities });
  }
  get currentKeyHex() {
    return this.applied.at(-1)?.key ?? null;
  }
}

/** Routes data messages between the connected devices, the way LiveKit's
 *  data channel would, honouring destinationIdentities. */
class Fabric {
  constructor() {
    this.members = new Map(); // identity -> { e2ee, joinedAtMs }
    this.errors = [];
  }
  sendFrom(identity) {
    return (payload, targets) => {
      const recipients = targets ?? [...this.members.keys()].filter((id) => id !== identity);
      for (const to of recipients) {
        const m = this.members.get(to);
        if (!m) continue;
        Promise.resolve()
          .then(() => m.e2ee.handleDataMessage(payload, identity))
          .catch((err) => this.errors.push(`${identity}->${to}: ${err.message}`));
      }
    };
  }
  participants() {
    return [...this.members.entries()].map(([identity, m]) => ({ identity, joinedAtMs: m.joinedAtMs }));
  }
  async announceMembership() {
    for (const { e2ee } of this.members.values()) {
      await e2ee.onMembershipChanged(this.participants());
    }
    await settle();
  }
}

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 15));
};

async function api(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function makeDevice(identity, fabric) {
  const token = tokens[identity];
  const keyProvider = new RecordingKeyProvider(identity);
  const state = { fingerprint: null, generation: -1, rejoinPrompts: 0, safetyNumbers: new Map() };

  const e2ee = new GroupE2EE({
    keyProvider,
    sendData: fabric.sendFrom(identity),
    fetchBundle: (email, deviceId) =>
      api(`/auth/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(deviceId)}`, { token }),
    fetchIdentity: (email, deviceId) =>
      api(`/auth/prekeys/${encodeURIComponent(email)}/${encodeURIComponent(deviceId)}/identity`, { token }),
    emailForIdentity: (id) => EMAIL[id],
    onFingerprintChanged: (fp, gen) => {
      state.fingerprint = fp;
      state.generation = gen;
    },
    onIdentitySafetyNumber: (peer, sn) => state.safetyNumbers.set(peer, sn),
    onRejoinNeeded: () => state.rejoinPrompts++,
    onPartialRotationFailure: (peers) => state.partialFailure = peers,
    bundleFetchRetryDelaysMs: [50, 150, 400],
  });

  return { identity, token, e2ee, keyProvider, state };
}

async function join(fabric, device, joinedAtMs) {
  const payload = await device.e2ee.initialize(device.identity);
  await api("/auth/prekeys/me", { token: device.token, method: "POST", body: payload });
  fabric.members.set(device.identity, { e2ee: device.e2ee, joinedAtMs });
}

function report(label, devices) {
  const rows = devices.map((d) => `${d.identity}=${d.state.fingerprint}(gen ${d.state.generation})`);
  console.log(`  ${label}: ${rows.join("  ")}`);
}

function assertAllAgree(devices, label) {
  const fps = devices.map((d) => d.state.fingerprint);
  assert.ok(fps.every((f) => f !== null), `${label}: every participant must have a fingerprint`);
  assert.equal(new Set(fps).size, 1, `${label}: fingerprints disagree -> ${fps.join(", ")}`);
  const keys = devices.map((d) => d.keyProvider.currentKeyHex);
  assert.equal(new Set(keys).size, 1, `${label}: underlying room keys differ despite matching fingerprints`);
  // The displayed fingerprint must actually be the fingerprint of the key
  // in use -- not merely equal across peers.
  return fps[0];
}

const results = [];
const step = async (name, fn) => {
  process.stdout.write(`\n[${name}]\n`);
  await fn();
  results.push(name);
};

const fabric = new Fabric();
const a = makeDevice("dev-a", fabric);
const b = makeDevice("dev-b", fabric);
const c = makeDevice("dev-c", fabric);

await step("1:1 call — fingerprints match on both ends", async () => {
  await join(fabric, a, 1000);
  await join(fabric, b, 2000);
  await fabric.announceMembership();

  report("after join", [a, b]);
  const fp = assertAllAgree([a, b], "1:1");

  const expected = await fingerprint(Buffer.from(a.keyProvider.currentKeyHex, "hex"));
  assert.equal(fp, expected, "displayed fingerprint must be SHA-256 of the room key in use");
  assert.equal(a.state.rejoinPrompts + b.state.rejoinPrompts, 0, "no rejoin prompt expected");
  console.log(`  room key fingerprint: ${fp}  (verified = SHA-256 of the active key)`);
});

await step("identity safety numbers agree out of band", async () => {
  const fromA = a.state.safetyNumbers.get("dev-b");
  const fromB = b.state.safetyNumbers.get("dev-a");
  console.log(`  dev-a sees: ${fromA}`);
  console.log(`  dev-b sees: ${fromB}`);
  assert.ok(fromA && fromB, "both sides must derive a safety number");
  assert.equal(fromA, fromB, "safety numbers must match between the pair");
});

await step("3-participant call — mid-call JOIN re-keys and all three agree", async () => {
  const before = a.state.fingerprint;
  await join(fabric, c, 3000);
  await fabric.announceMembership();

  report("after dev-c joins", [a, b, c]);
  const fp = assertAllAgree([a, b, c], "3-way join");
  assert.notEqual(fp, before, "a join must rotate the room key (§6.1), not reuse it");
  console.log(`  rotated ${before} -> ${fp}`);
});

await step("mid-call LEAVE re-keys and the remaining participants agree", async () => {
  const before = a.state.fingerprint;
  const departedKey = c.keyProvider.currentKeyHex;

  fabric.members.delete("dev-c");
  await fabric.announceMembership();

  report("after dev-c leaves", [a, b]);
  const fp = assertAllAgree([a, b], "post-leave");
  assert.notEqual(fp, before, "a leave must rotate the room key (§6.1)");
  assert.notEqual(
    a.keyProvider.currentKeyHex,
    departedKey,
    "the departed participant's key must no longer be the active one"
  );
  console.log(`  rotated ${before} -> ${fp}; dev-c's last key is no longer active`);
});

await step("no errors, no rejoin prompts across the whole session", async () => {
  assert.deepEqual(fabric.errors, [], `data-channel handler errors: ${fabric.errors.join(" | ")}`);
  for (const d of [a, b, c]) {
    assert.equal(d.state.rejoinPrompts, 0, `${d.identity} was prompted to rejoin`);
  }
  console.log("  clean");
});

console.log(`\nAll ${results.length} steps passed.`);
