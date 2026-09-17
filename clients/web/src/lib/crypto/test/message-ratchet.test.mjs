import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_SKIP, MessageRatchet } from "../message-ratchet.js";

const AD = new TextEncoder().encode("alice-ik|bob-ik");

function text(s) {
  return new TextEncoder().encode(s);
}
function read(buf) {
  return new TextDecoder().decode(buf);
}

/** Mirrors the real bootstrap: both sides hold the same X3DH secret, and
 * Bob's ratchet keypair is the signed prekey Alice already fetched. */
async function pair() {
  const sharedSecret = crypto.getRandomValues(new Uint8Array(32)).buffer;
  const bobRatchet = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  const bobPublicRaw = await crypto.subtle.exportKey("raw", bobRatchet.publicKey);

  const alice = await MessageRatchet.initSender(sharedSecret, bobPublicRaw, AD);
  const bob = await MessageRatchet.initReceiver(sharedSecret, bobRatchet, AD);
  return { alice, bob };
}

test("a message encrypted by the initiator decrypts on the responder", async () => {
  const { alice, bob } = await pair();
  const envelope = await alice.encrypt(text("hello"));
  assert.equal(read(await bob.decrypt(envelope)), "hello");
});

test("the responder can reply once it has received a message", async () => {
  const { alice, bob } = await pair();
  await bob.decrypt(await alice.encrypt(text("ping")));
  assert.equal(read(await alice.decrypt(await bob.encrypt(text("pong")))), "pong");
});

test("the responder cannot send before receiving anything", async () => {
  const { bob } = await pair();
  await assert.rejects(() => bob.encrypt(text("too early")), /no sending chain/);
});

test("many messages survive a long back-and-forth with DH ratchet steps", async () => {
  const { alice, bob } = await pair();
  for (let i = 0; i < 12; i++) {
    assert.equal(read(await bob.decrypt(await alice.encrypt(text(`a${i}`)))), `a${i}`);
    assert.equal(read(await alice.decrypt(await bob.encrypt(text(`b${i}`)))), `b${i}`);
  }
});

test("out-of-order delivery within one chain still decrypts", async () => {
  const { alice, bob } = await pair();
  const first = await alice.encrypt(text("first"));
  const second = await alice.encrypt(text("second"));
  const third = await alice.encrypt(text("third"));

  assert.equal(read(await bob.decrypt(third)), "third");
  assert.equal(read(await bob.decrypt(first)), "first");
  assert.equal(read(await bob.decrypt(second)), "second");
});

test("a message lost across a DH ratchet step is still decryptable afterwards", async () => {
  const { alice, bob } = await pair();
  const dropped = await alice.encrypt(text("dropped"));
  await bob.decrypt(await alice.encrypt(text("delivered")));

  // Bob replies, which steps the ratchet on both sides, and only then does
  // the straggler from the previous chain turn up.
  await alice.decrypt(await bob.encrypt(text("reply")));
  assert.equal(read(await bob.decrypt(dropped)), "dropped");
});

test("a skipped key is not consumed when a forged message fails to authenticate", async () => {
  const { alice, bob } = await pair();
  const skipped = await alice.encrypt(text("skipped"));
  await bob.decrypt(await alice.encrypt(text("next")));

  const forged = { ...skipped, ciphertext: skipped.ciphertext.replace(/^./, (c) => (c === "A" ? "B" : "A")) };
  await assert.rejects(() => bob.decrypt(forged));

  assert.equal(read(await bob.decrypt(skipped)), "skipped");
});

test("tampering with the header is rejected because it is authenticated", async () => {
  const { alice, bob } = await pair();
  const envelope = await alice.encrypt(text("intact"));
  await assert.rejects(() =>
    bob.decrypt({ ...envelope, header: { ...envelope.header, n: envelope.header.n + 5 } })
  );
});

test("a header claiming an absurd skip is refused rather than derived", async () => {
  const { alice, bob } = await pair();
  const envelope = await alice.encrypt(text("x"));
  await bob.decrypt(envelope);

  const next = await alice.encrypt(text("y"));
  await assert.rejects(
    () => bob.decrypt({ ...next, header: { ...next.header, n: MAX_SKIP + 50 } }),
    /refusing/
  );
});

test("each message uses a distinct key, so ciphertexts of identical plaintext differ", async () => {
  const { alice } = await pair();
  const a = await alice.encrypt(text("same"));
  const b = await alice.encrypt(text("same"));
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.header.n, b.header.n);
});

test("a ratchet for a different session cannot decrypt the message", async () => {
  const { alice } = await pair();
  const { bob: strangerBob } = await pair();
  const envelope = await alice.encrypt(text("secret"));
  await assert.rejects(() => strangerBob.decrypt(envelope));
});
