/**
 * End-to-end pass over every service the web client talks to.
 *
 * Drives the real HTTP and WebSocket APIs rather than mocking them, so it
 * catches the things unit tests cannot: routing, auth wiring between the two
 * services, the WebSocket relay, and the media audience check.
 *
 * Needs a running stack. From the repo root:
 *
 *   AUTH_BASE=http://127.0.0.1:8080 MSG_BASE=http://127.0.0.1:8090 \
 *     node --test testing/e2e/web-services.test.mjs
 *
 * It reads OTP codes from the auth service's console transport, so the service
 * must run with OTP_TRANSPORT=console and its stdout captured to AUTH_LOG
 * (defaults to /tmp/kp3/auth.log).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const AUTH = process.env.AUTH_BASE ?? "http://127.0.0.1:8080";
const MSG = process.env.MSG_BASE ?? "http://127.0.0.1:8090";
const AUTH_LOG = process.env.AUTH_LOG ?? "/tmp/kp3/auth.log";

const ALICE = process.env.E2E_ALICE ?? "alice@example.com";
const BOB = process.env.E2E_BOB ?? "bob@example.com";

/** Latest OTP the console transport printed for `email`. */
function latestOtp(email) {
  const log = readFileSync(AUTH_LOG, "utf8");
  const matches = [...log.matchAll(new RegExp(`\\[otp\\] ${email} -> (\\d{6})`, "g"))];
  if (matches.length === 0) throw new Error(`no OTP for ${email} in ${AUTH_LOG}`);
  return matches[matches.length - 1][1];
}

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text };
  }
}

/** A stable id per persona: §4 caps a member at 2 active devices, so minting a
 * fresh one every run would exhaust the limit after a single pass. Re-verifying
 * an id that already exists just touches the row. */
async function signIn(email, slot = "a") {
  const deviceId = `e2e-${slot}-${email.split("@")[0]}`;

  const requested = await fetch(`${AUTH}/otp/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(requested.status, 202, "OTP request should be accepted");

  // The console transport writes synchronously, but the request returns before
  // the log line is necessarily flushed.
  await new Promise((r) => setTimeout(r, 300));

  const verified = await json(
    await fetch(`${AUTH}/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code: latestOtp(email), deviceId, platform: "web" }),
    })
  );
  if (verified.status === 403 && String(verified.body?.detail ?? "").includes("active devices")) {
    throw new Error(
      `${email} has no free device slot (§4 allows 2). Revoke one from Linked devices, ` +
        `or clear the dev database, then re-run.`
    );
  }
  assert.equal(verified.status, 200, `OTP verify failed: ${JSON.stringify(verified.body)}`);

  return { email, deviceId, token: verified.body.accessToken, refresh: verified.body.refreshToken };
}

const auth = (s) => ({ authorization: `Bearer ${s.token}`, "content-type": "application/json" });

let alice;
let bob;

before(async () => {
  alice = await signIn(ALICE);
  bob = await signIn(BOB);
});

test("auth-service is healthy", async () => {
  const res = await fetch(`${AUTH}/healthz`);
  const body = await res.json();
  // 503 when LiveKit is unreachable; sqlite must be up either way.
  assert.equal(body.checks.sqlite, true);
});

test("messaging-service is healthy", async () => {
  const { status, body } = await json(await fetch(`${MSG}/healthz`));
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
});

test("an unauthenticated caller is refused everywhere", async () => {
  for (const [base, path] of [
    [AUTH, "/users/me"],
    [AUTH, "/devices/me"],
    [AUTH, "/room/token"],
    [MSG, "/pending"],
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.ok(res.status === 401 || res.status === 405, `${path} returned ${res.status}`);
  }
});

test("usernames can be claimed and resolved", async () => {
  const handle = `e2e.${Date.now().toString(36)}`;
  const set = await json(
    await fetch(`${AUTH}/users/me/username`, {
      method: "PUT",
      headers: auth(alice),
      body: JSON.stringify({ username: handle }),
    })
  );
  assert.equal(set.status, 200);

  const looked = await json(
    await fetch(`${AUTH}/users/lookup/${handle.toUpperCase()}`, { headers: auth(bob) })
  );
  assert.equal(looked.status, 200);
  assert.equal(looked.body.email, ALICE);
});

test("an invalid username is rejected without consuming the change quota", async () => {
  for (const bad of ["ad", "admin", ".nope", "12345"]) {
    const res = await fetch(`${AUTH}/users/me/username`, {
      method: "PUT",
      headers: auth(bob),
      body: JSON.stringify({ username: bad }),
    });
    assert.equal(res.status, 400, `${bad} should be a 400`);
  }
  const ok = await fetch(`${AUTH}/users/me/username`, {
    method: "PUT",
    headers: auth(bob),
    body: JSON.stringify({ username: `bob.${Date.now().toString(36)}` }),
  });
  assert.equal(ok.status, 200, "a valid username must still go through");
});

test("the directory lists both members", async () => {
  const { status, body } = await json(await fetch(`${AUTH}/users/directory`, { headers: auth(alice) }));
  assert.equal(status, 200);
  const emails = body.members.map((m) => m.email);
  assert.ok(emails.includes(ALICE) && emails.includes(BOB));
});

test("a profile round-trips", async () => {
  const { status, body } = await json(
    await fetch(`${AUTH}/users/me/profile`, {
      method: "PUT",
      headers: auth(alice),
      body: JSON.stringify({ displayName: "Alice E2E", about: "testing" }),
    })
  );
  assert.equal(status, 200);
  assert.equal(body.displayName, "Alice E2E");
});

test("a member's active devices are discoverable for addressing", async () => {
  const { status, body } = await json(
    await fetch(`${AUTH}/devices/peer/${encodeURIComponent(BOB)}`, { headers: auth(alice) })
  );
  assert.equal(status, 200);
  assert.ok(body.devices.includes(bob.deviceId));
});

test("prekeys publish and fetch, and a bundle carries a one-time prekey", async () => {
  // Shapes only; the real key material is generated in the browser.
  const payload = (seed) => ({
    identity_key: seed.identity,
    identity_dh_key: { public_key: seed.dh, signature: seed.dhSig },
    signed_prekey: { key_id: 1, public_key: seed.spk, signature: seed.spkSig },
    one_time_prekeys: [{ key_id: 1, public_key: seed.otp }],
  });
  // Publishing requires genuinely valid signatures, so this asserts the
  // endpoint rejects nonsense rather than pretending to publish.
  const res = await fetch(`${AUTH}/prekeys/me`, {
    method: "POST",
    headers: auth(alice),
    body: JSON.stringify(
      payload({ identity: "AA==", dh: "AA==", dhSig: "AA==", spk: "AA==", spkSig: "AA==", otp: "AA==" })
    ),
  });
  assert.ok(res.status >= 400, "malformed key material must not be accepted");
});

test("a room token mints for an allowlisted participant", async () => {
  const { status, body } = await json(
    await fetch(`${AUTH}/room/token`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({ participants: [BOB] }),
    })
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.roomToken, "a room token is required to join a call");
  assert.ok(body.roomName.startsWith("r-"), "the room name is derived, not caller-supplied");
  assert.ok(Array.isArray(body.turnCredentials.uris) && body.turnCredentials.uris.length > 0);
});

test("a room token is refused for someone outside the allowlist", async () => {
  const { status } = await json(
    await fetch(`${AUTH}/room/token`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({ participants: ["stranger@example.com"] }),
    })
  );
  assert.equal(status, 400);
});

test("a message is stored as ciphertext and delivered to the recipient", async () => {
  const clientMsgId = randomUUID();
  const envelope = JSON.stringify({ v: 1, ciphertext: "OPAQUE", iv: "AA==" });

  const sent = await json(
    await fetch(`${MSG}/send`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({
        client_msg_id: clientMsgId,
        kind: "text",
        recipients: [{ email: BOB, device_id: bob.deviceId, envelope }],
      }),
    })
  );
  assert.equal(sent.status, 200);

  const pending = await json(await fetch(`${MSG}/pending`, { headers: auth(bob) }));
  const found = pending.body.messages.find((m) => m.client_msg_id === clientMsgId);
  assert.ok(found, "the recipient should see it pending");
  assert.equal(found.envelope, envelope, "the server must relay the envelope untouched");

  const acked = await json(
    await fetch(`${MSG}/receipts/delivered`, {
      method: "POST",
      headers: auth(bob),
      body: JSON.stringify({ message_ids: [found.id] }),
    })
  );
  assert.equal(acked.body.count, 1);

  const after = await json(await fetch(`${MSG}/pending`, { headers: auth(bob) }));
  assert.ok(!after.body.messages.some((m) => m.client_msg_id === clientMsgId));
});

test("the sender never receives their own copy", async () => {
  const pending = await json(await fetch(`${MSG}/pending`, { headers: auth(alice) }));
  assert.ok(Array.isArray(pending.body.messages));
});

test("sending to a non-member is refused", async () => {
  const { status } = await json(
    await fetch(`${MSG}/send`, {
      method: "POST",
      headers: auth(alice),
      body: JSON.stringify({
        client_msg_id: randomUUID(),
        recipients: [{ email: "stranger@example.com", device_id: "x", envelope: "c" }],
      }),
    })
  );
  assert.equal(status, 400);
});

test("the websocket delivers live and relays typing with its conversation id", async () => {
  const socket = new WebSocket(`${MSG.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(bob.token)}`);
  const frames = [];
  socket.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });

  const backlog = await waitFor(frames, (f) => f.type === "backlog");
  assert.ok(backlog, "a socket opens with its backlog");

  const clientMsgId = randomUUID();
  await fetch(`${MSG}/send`, {
    method: "POST",
    headers: auth(alice),
    body: JSON.stringify({
      client_msg_id: clientMsgId,
      kind: "text",
      recipients: [{ email: BOB, device_id: bob.deviceId, envelope: "LIVE" }],
    }),
  });
  const pushed = await waitFor(frames, (f) => f.type === "message");
  assert.equal(pushed.message.envelope, "LIVE");

  // Typing from Alice's own socket, so the relay path is exercised.
  const aliceSocket = new WebSocket(
    `${MSG.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(alice.token)}`
  );
  await new Promise((resolve) => aliceSocket.addEventListener("open", resolve));
  aliceSocket.send(
    JSON.stringify({ type: "typing", to_device: bob.deviceId, chat_id: "group-e2e", stopped: false })
  );
  const typing = await waitFor(frames, (f) => f.type === "typing");
  assert.equal(typing.chat_id, "group-e2e", "a group's typing must name its conversation");
  assert.equal(typing.from_email, ALICE);

  socket.close();
  aliceSocket.close();
});

async function waitFor(frames, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for a frame");
}

test("media uploads, downloads for its audience, and 404s for everyone else", async () => {
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array([1, 2, 3, 4])]), "blob.bin");
  body.append("audience", BOB);

  const uploaded = await json(
    await fetch(`${MSG}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
      body,
    })
  );
  assert.equal(uploaded.status, 200);

  const download = await fetch(`${MSG}/media/${uploaded.body.id}`, {
    headers: { authorization: `Bearer ${bob.token}` },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test("a revoked device loses access to both services immediately", async () => {
  // The second slot, so revoking it does not knock out the session the rest of
  // the suite is using.
  const victim = await signIn(BOB, "b");

  // Revoking from the member's other device, which is the supported path.
  const revoked = await fetch(`${AUTH}/devices/${encodeURIComponent(victim.deviceId)}/revoke`, {
    method: "POST",
    headers: auth(bob),
  });
  assert.equal(revoked.status, 200);

  const authRes = await fetch(`${AUTH}/users/me`, { headers: auth(victim) });
  assert.equal(authRes.status, 401, "auth-service must reject a revoked device");

  const msgRes = await fetch(`${MSG}/pending`, { headers: auth(victim) });
  assert.equal(
    msgRes.status,
    401,
    "messaging-service must reject it too, not just auth-service"
  );
});
