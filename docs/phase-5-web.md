# Phase 5 — web half

Done. This records what that means, and more usefully what it does not.

Phase 5 as a whole is **not** done: §13's done-bar is an incoming call ringing
on an Android lock screen over a dual FCM/WS wake path, and
`clients/android/` is still a placeholder. What follows is the half that can
be finished without it.

## The done-bar this half was held to

A member can install nothing, open a browser, and use the app the way they
would use any other messenger — send and receive, call, be told when
something arrives while the app is shut, and get their history onto a new
device — with every one of those paths exercised against real services in a
real browser rather than against a mock.

## What is here

| Area | |
|---|---|
| Messaging | text, media, voice notes, stickers, GIFs, documents, location, contact cards, replies, forward, edit (15-minute window), delete for me and for everyone, reactions, starred, view-once, formatting, mentions, drafts, retrying outbox, albums, disappearing messages, pinned messages, scheduled send |
| Chat list | pin, archive, mute, mark unread, global search with jump-to-message, arrow-key navigation, unread pills, OS badge |
| Groups | admins, add and remove, description, photo, revision-based conflict resolution, system notices, per-device fanout |
| Calls | 1:1 and group, screen share, background blur, raise hand, in-call messages, spotlight pinning, camera switch, device picker, PiP, active speakers, connection quality, reconnect, ringing, call log |
| Crypto | X3DH, Double Ratchet, group E2EE, SFrame, identity pinning, security-code change notices, key rotation, scannable safety numbers |
| Privacy | read-receipt / typing / last-seen toggles with server-enforced reciprocity, presence, screenshot blackout, PIN and platform-authenticator lock, status audience |
| Backup | passphrase-encrypted, scheduled, media opt-in, restore onto a fresh device, automatic restore drill |
| Reach | service worker, Web Push via `wake-service`, attachment backfill from a sibling device, chat export as text or zip |

## Things that are true and easy to forget

**`worker-src blob:` in `src/proxy.ts` is load-bearing.** Remove it and
livekit-client cannot build its frame-cryptor worker, the call engine falls
back to `worker = null`, and calls proceed **unencrypted** with nothing in
the UI saying so.

**The ratchet must not advance before the AEAD verifies.** `message-ratchet.js`
snapshots and rolls back on a failed decrypt; without it a redelivered
envelope desynchronises the chain permanently.

**Local data belongs to one member.** `lib/auth/local-data.ts` decides, proves,
then destroys — a wipe must never happen before the login is authenticated.

**The push payload carries nothing.** `{"v":1,"r":"message"}`. No sender, no
chat, no preview. The service worker deliberately does not decrypt: the
ratchet has one writer, and giving it two desynchronises it.

**Blur's model is served from `/vision/`, not a CDN.** The library defaults to
jsDelivr and storage.googleapis.com, which would tell two third parties that
a private call just started. The wasm is copied from npm at build time by
`scripts/vendor-vision-assets.mjs`; the model is committed because it has no
npm source and a build that needs the network fails exactly when it matters.

## Deliberately not done

**i18n.** `lang="en"` is hardcoded. Real Hindi and Russian translations are
needed and inventing them would be worse than the honest default. This is the
one item from the original review left open on purpose.

**Background send.** A scheduled message goes out when the app is running. No
browser reliably runs code at a chosen moment with every tab shut, so the UI
says so and reports how late a message actually went rather than implying it
was on time.

**The §10.2 persistent-WS wake fallback.** For the web client the second
socket already exists — messaging-service's delivery socket, live whenever a
tab is. The fallback belongs with the Android client, where a native FCM path
and its outage are what the dual channel is for.

**Polls, communities, channels, broadcast lists, group invite links.** All of
it exists to solve "strangers at scale". The allowlist is capped at ten people
who already know each other.

**Replying to a status.** You can view one and the author learns it was seen,
but there is no way to answer it from the viewer. Known gap, not a decision.

**Reactions and pinning from inside an album.** A photo in a grid has no
bubble menu; the viewer carries reply, forward, star and info, and a
long-press ungroups the album so every other action is reachable through the
ordinary bubble. Reacting to one photo without ungrouping first is the one
thing still missing.

## Verified against real services

OTP login, E2EE messaging, group chat, media, calls, tenant isolation in both
directions, backup round-trip (server file inspected byte-wise: no plaintext,
600,000 iterations in the header), restore onto a fresh device with every
server blob deleted, presence, disappearing-message sweep, pinned messages,
find-in-chat, message info, chat export, focus traps, and the safety-number QR
decoded from the rendered UI by OpenCV.

In the user's own Chrome, with real permissions: background blur on a live
1280×720 camera track loading only from this origin; raised hands and in-call
messages crossing between two real participants; a real FCM subscription
accepted by Google with `201 Created`.

Two things could not be verified here and are known-unverified rather than
known-good: **a push notification rendering on screen** (Windows suppresses
Chrome notifications on the test machine — a bare `showNotification` also
displays nothing, so this is environmental, not code), and **the UDP relay
path** (Windows reserves the port range coturn needs, so local calls were
exercised over ICE/TCP).

## Test counts at sign-off

auth 180 · messaging 104 · wake 51 · web 441 · harness 44 · e2e 17.
