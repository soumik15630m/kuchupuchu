# WebRTC test harness (§13 Phase 3)

Not a Phase 5 client — `clients/web` and `clients/android` stay placeholders
until then. This is a throwaway browser harness that exists only so Phase 3's
call-quality features (simulcast/Dynacast/adaptive stream, data-saver,
audio-only fallback, connection-quality reporting) have somewhere to live
and be exercised before the real client exists.

## Running it

Any static file server works, e.g.:

```
cd testing/webrtc-harness
python3 -m http.server 8000
```

Then open `http://localhost:8000`, paste in:
- a LiveKit server URL (`wss://<PUBLIC_HOSTNAME>`)
- a room token and ICE server list — both returned by a single call to
  `POST /auth/room/token` (`{ roomToken, livekitUrl, turnCredentials }`,
  same as the Phase 1/2 walkthroughs in the root README). Build the
  `iceServers` array the harness expects from `turnCredentials.uris`
  (`urls`), `turnCredentials.username`, and `turnCredentials.password`
  (`credential`).

## What it exercises

- **Simulcast + Dynacast + adaptive stream** — enabled in `connect()`'s
  `publishDefaults`/room options (§13 Phase 3).
- **Data-saver toggle** — forces all remote video subscriptions to LOW
  quality and republishes local video at a reduced resolution/bitrate
  preset, rather than just hiding the UI control.
- **Audio-only fallback** — fully unpublishes the local video track
  (`setCameraEnabled(false)`), and auto-triggers itself after a
  configurable run of sustained POOR connection-quality events, matching
  §13 Phase 3's scope.
- **ICE restart** — handled internally by the LiveKit JS SDK's own
  reconnect policy; the harness just surfaces `Reconnecting`/`Reconnected`
  room events and logs the winning candidate pair afterward, since that's
  the signal the Phase 3 done-bar actually cares about.
- **Connection-quality reporting** — listens for `ConnectionQualityChanged`
  and periodically pulls `getRTCStatsReport()` off the active track to
  extract the selected candidate pair's type (host/srflx/relay) and relay
  protocol (udp/tcp/tls), POSTing snapshots to `/auth/quality/report`.
  View them at `/auth/quality/dashboard`.
- **Pre-connect ICE probe + stricter failure reporting** — before calling
  `room.connect()`, gathers ICE candidates against the same server list
  with a throwaway `RTCPeerConnection` and logs every type/protocol found,
  so "no reachable candidates" shows up immediately instead of manifesting
  90+ seconds later as an opaque "could not establish pc connection".
  `Disconnected` events log the actual `DisconnectReason` name (not the
  raw numeric code), `connect()` is wrapped with a timeout instead of
  hanging silently, and connection errors surface `.reason`/`.status`
  when present, not just the generic message.

## Validation strategy (§13 Phase 3, revised)

Originally scoped as "a week of real calls over the actual India↔Russia
link." Revised to: run this harness from two browser tabs against the
local docker-compose stack, with `scripts/network-emulation.sh` and
`scripts/toxiproxy-scenarios.sh` (see repo root) driving Russia-representative
conditions (latency/jitter/loss, simulated DPI UDP-blocking, and scripted
TURN/TLS-path cuts) instead of waiting on the real link or the counterparty's
availability. See design-doc-v6.md §13 Phase 3 for the exact done-bar.

## Phase 4: end-to-end encryption

`signal-crypto.js` implements X3DH key agreement (identity generation,
bundle publish/fetch payloads, initiator/responder session establishment)
directly on WebCrypto's X25519/Ed25519/HKDF primitives -- see the
module's own header comment for why that's the right call here instead
of reaching for a third-party library. `double-ratchet.js` builds the
symmetric-ratchet key derivation on top of that shared secret.

Both are plain ES modules with no build step, same as `app.js`, and both
have real unit tests runnable under Node (which has its own compatible
WebCrypto implementation, so these exercise the actual code path rather
than a mock):

```
cd testing/webrtc-harness
node --test test/*.test.mjs
```

`assertSecureCurvesSupported()` in `signal-crypto.js` fails loudly if a
browser doesn't support WebCrypto X25519/Ed25519 -- check that before
relying on E2EE working in a given browser.

### Running it in two tabs

1. Fill in the LiveKit URL/token/access-token fields as usual (§13 Phase 3).
2. Fill in the **device → email roster** field with a JSON object mapping
   every other participant's LiveKit identity (= device id) to their
   email, e.g. `{"dev-b": "b@example.com"}`. This is a testing-harness
   concession, not something a real client needs -- see `group-e2ee.js`'s
   header comment for why. Get identities from each tab's own connect log
   or from whatever minted the room tokens.
3. Click Connect in both tabs. Each tab publishes its own prekey bundle
   after connecting (once its real LiveKit identity is known), then the
   deterministically-elected earliest joiner generates and distributes
   the room key.
4. Compare the fingerprint shown under the video in both tabs -- they
   should match. If a "rejoin" banner appears instead, see §6.1's
   mismatch-retry policy in `rotation.js`.

Actual frame encryption/decryption runs through LiveKit's own built-in
E2EE (`key-provider.js`'s `GroupKeyProvider` feeds it the rotation-
derived key) -- see that file's header comment for the one piece of this
Phase 4 work that isn't unit tested here: it needs a real browser and a
real LiveKit connection to exercise meaningfully, unlike the crypto
modules above. `E2EE_WORKER_URL` there is pinned to an exact
`livekit-client` version to match the SRI-pinned `<script>` tag in
`index.html` -- if that version is ever bumped, bump both together.

