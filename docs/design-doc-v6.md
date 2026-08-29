# Private Voice/Video App — Architecture Design Doc (v6, Consolidated)

v5 folded the v4 gap-review findings directly into the sections they touch. Six real gaps from that review were resolved there: revocation reaching an already-connected session (§4), nightly-backup/revocation interaction (§4, §11), web identity storage eviction (§4), FCM as a single point of failure (§10.2), key-rotation mismatch recovery (§6.1), and the Redis status inconsistency (§8). The DR redeploy playbook that §11's "under an hour" target depended on became an actual artifact (`docker-compose.yml` + `REDEPLOY-RUNBOOK.md`), not a reference to one. §9 added an explicit list of accepted external-dependency risks instead of leaving them unstated. §12 replaced v4's status claim with an accurate one.

**v6 changes two things:**
1. **Hosting, for now: local Docker instead of Hetzner.** Every reference to the Hetzner CX23 is replaced with a local Docker Compose stack running on the operator's own machine/network. This is a near-term/dev-phase substitution, not a final production decision — it removes the truestele.com co-location concern for now, but introduces a new open item (public reachability from a home network) that production hosting will need to resolve. Flagged inline everywhere it matters (§1, §3, §7, §8, §11).
2. **Added §13, Implementation Phases** — the build sequence, with an explicit "done" bar for each phase.

---

## 1. Purpose & Constraints

| Constraint | Value |
|---|---|
| Total known members ever allowed in | ≤ 10 |
| Concurrent participants in a call | ≤ 5 |
| Primary link | Russia ↔ India |
| Priority | Call quality/robustness (no jitter) over infra simplicity |
| Security bar | Industry-standard, not "good enough for 2 friends" |
| Hosting | **(v6)** Local Docker Compose stack on the operator's own machine/network, for now. Production hosting (Hetzner or otherwise, possibly shared with truestele.com) is a deferred, separate decision — see §1a. |
| Operator skill | Comfortable coding & deploying |

### 1a. Hosting substitution (v6): local Docker, not Hetzner — what this does and doesn't change

Everything in §2–§9 (topology, access control, encryption, NAT strategy, security posture) is **hosting-independent** — it describes what runs, not where. Swapping Hetzner for local Docker only touches the *deployment* sections: §3's diagram, §8's footprint, and §11's DR plan, all updated below.

**What it does change, and is left open rather than solved here:** a Hetzner VPS has a public IP by construction; a machine on a home network usually doesn't. §7's entire TURN-on-443 strategy assumes the box is reachable from the public internet on 443/3478/7881. Running locally means one of the following has to be added before real calls (not just same-LAN testing) work at all:
- port-forwarding the relevant ports on the home router, or
- a reverse tunnel (e.g., a Cloudflare Tunnel or Tailscale Funnel) terminating at the local Docker stack.

This doc doesn't pick one yet — it's a Phase 1 decision (§13) — but it's called out here so it isn't silently assumed away.

Two of your requests directly change the v1 recommendation:

1. **"Don't want jitter"** at 5 concurrent → full mesh is the wrong topology now (see §2).
2. **"Industry standard" + "over-engineer NAT/reliability"** → stop hand-rolling signaling/TURN glue and build on a proven open-source SFU stack that already solves congestion control, simulcast, and reconnection properly.

---

## 2. Topology: Switching Mesh → SFU

**Mesh cost is O(n²).** At 5 participants, each peer maintains 4 simultaneous upload streams + 4 download streams. The weakest link (your girlfriend's Russian connection, likely already constrained by ISP interference) has to *upload* video 4 times simultaneously — that's the direct cause of the jitter/quality drop you're trying to avoid.

A **Selective Forwarding Unit (SFU)** flips this: each participant uploads **once** to the server, which forwards (not transcodes) it to the other 4. Upload burden becomes constant regardless of group size. SFU also unlocks **simulcast** (§5) and centralized, consistent congestion control.

**Decision: self-hosted SFU, not mesh.**

### Which SFU
Recommendation: **LiveKit** (Apache-2.0, self-hostable, single Go binary + config).
- Built-in TURN/STUN, simulcast, adaptive stream degradation, reconnection/ICE-restart handling.
- Native support for **frame-level end-to-end encryption** via WebRTC Insertable Streams (§6).
- JWT-based room tokens map cleanly onto your "known members" access model (§4).
- Single self-hosted binary — realistic for a CX23, no k8s/multi-service sprawl required.

(Alternative considered: mediasoup — more flexible/lower-level, but you'd be hand-building the parts LiveKit already ships. Not worth it at this scale.)

**Note on TURN specifically:** LiveKit ships a built-in TURN server, but this design uses a *standalone* **coturn** instance instead (see §7.1) so that TURN-over-443 traffic can be demuxed from the rest of the HTTPS traffic on the box at the nginx layer, independent of LiveKit's own signaling port.

---

## 3. System Components

```
                              ┌─────────────────────────────────────────────────────┐
                              │        Local Docker Compose stack (v6, temporary)     │
  Browser (India)  ────┐      │  ┌──────────┐                                        │
                        ├─???─┼─▶│  Nginx    │──── (stream, SNI-demux) ──────────────┤
  Browser (Russia) ────┘      │  │(TLS term.)│                    │                  │
  Android app     ────┘       │  └──────────┘                     ▼                  │
                              │        │                     coturn (TURN/TLS)        │
                              │        ▼                                              │
                              │  LiveKit Server ─── Redis (room state)                │
                              │  (SFU + simulcast,        │                           │
                              │   E2EE hooks)              ▼                           │
                              │        │              SQLite ◀── Auth svc              │
                              │        │           (allowlist, device table,           │
                              │        │            OTP records)                       │
                              │        │                  │                           │
                              │        │                  ▼                           │
                              │        │        Revocation log (append-only,           │
                              │        │        written to R2 in real time, §4/§11)    │
                              │        ▼                                              │
                              │  Wake service ── FCM (primary) + persistent WS         │
                              │  (dual-channel wake, §10.2)   (fallback, §10.2)        │
                              │        │                                              │
                              │        ▼                                              │
                              │  Messaging svc ── Cloudflare R2 (encrypted             │
                              │  (store-and-forward)   blobs, §10.4)                  │
                              └─────────────────────────────────────────────────────┘
```

`???` on the inbound edge above marks the open reachability question from §1a — port-forward or tunnel, decided in Phase 1. Once decided it's still 443 at the nginx layer; only the path *before* it changes.

- **LiveKit server** — the SFU. Handles live-call media forwarding, simulcast layer selection, congestion control, reconnection.
- **coturn** — dedicated TURN/TLS relay, reached via nginx's SNI-based stream demux on 443 (§7.1).
- **Auth service** — checks passcode/OTP + membership/concurrency limits, mints signed short-lived JWT room tokens, owns the **SQLite database** (allowlist, per-device table, OTP records), and writes every revocation event to an **append-only revocation log in R2** the instant it happens (§4, §11) — separate from and more frequent than the nightly SQLite snapshot.
- **Wake service** — new in v5. Maintains the FCM push path as primary, plus a lightweight authenticated **persistent WebSocket** as a fallback delivery channel for incoming-call and device-list-changed events, so a single Google outage doesn't block every call (§10.2).
- **Redis** — now a required component (not optional, see §8), holding LiveKit room state across restarts/deploys.
- **Messaging service** (async, separate from live calls — §10.4) — voice notes, file transfer, text messages: store-and-forward via Cloudflare R2 when offline, direct WebRTC data channel when both online, Signal Protocol for end-to-end encryption of this content.
- **Nginx** — TLS termination and reverse proxy, plus the stream-level SNI demux that routes TURN-over-443 traffic to coturn (§7.1).
- **Client** — native Android app and a Next.js web client (§10.1), both using LiveKit's SDK for calls and a Signal-Protocol-based messaging layer for voice notes/files.

---

### 3a. Repository Layout

Industry-standard monorepo split: `infra/` for anything that's mostly config wrapping a third-party binary, `services/` for code we own, `clients/` for the two frontends, `docs/` for this file. One `docker-compose.yml` at the root wires them together — see §1a for why the compose file targets local Docker rather than a specific host right now.

```
.
├── docker-compose.yml          # wires everything below together
├── docker-compose.testing.yml   # Phase 3 overlay — toxiproxy in front of the TURN/TLS path
├── .env.example                 # copy to .env — see §1a's PUBLIC_HOSTNAME note
├── docs/
│   └── design-doc-v6.md         # this file
├── infra/                       # config wrapping a third-party binary — no app logic
│   ├── nginx/                   # TLS termination + §7.1's SNI stream-demux
│   ├── coturn/                  # standalone TURN/TLS relay (§2, §7.1)
│   └── livekit/                 # SFU config (§2, §3)
├── services/                    # code we own
│   ├── auth-service/            # OTP login, allowlist, JWT + TURN credential minting (§4), device
│   │                             # revocation (§13 Phase 2), call-quality reporting (§13 Phase 3)
│   ├── wake-service/            # dual-channel FCM+WS wake (§10.2) — Phase 5, placeholder for now
│   └── messaging-service/       # store-and-forward voice/file/text (§10.4) — Phase 6, placeholder for now
├── clients/
│   ├── web/                     # Next.js + LiveKit JS SDK (§10.1) — Phase 5, placeholder for now
│   └── android/                 # Kotlin + LiveKit Android SDK (§10.1) — Phase 5, placeholder for now
├── testing/
│   └── webrtc-harness/          # throwaway browser harness for Phase 3 features (§13) — not a
│                                # real client, exists only until Phase 5's clients replace it
└── scripts/                     # one-off operator scripts (dev certs, network emulation, etc.) —
                                 # not part of the runtime stack
```

Each `services/*` and `clients/*` folder that isn't built yet ships with just a `README.md` stating what phase builds it and pointing back to the relevant doc section — so the tree always matches what actually exists, not what's planned.

---

## 4. Access Control & Identity Model

- **Login**: OTP-based, sent to a pre-provisioned **email address**. Only pre-provisioned emails on the allowlist can request an OTP at all.
  - **Delivery**: a third-party transactional email provider, not self-hosted SMTP. This is an accepted external dependency — see §9's dependency list.
  - **Rate limiting**: max 5 OTP requests per email per hour; max 5 verification attempts per issued OTP before it's invalidated; standard exponential backoff on repeated failures.

- **Device identity — Android and Web, both persistent**: on first successful login, each client generates and stores a device identity keypair — **Android Keystore** (hardware-backed where available) on the native app, and the equivalent persistent identity on the Next.js web client.
  - **Web identity fragility (v5 fix)**: a browser-stored key is not equivalent to Android Keystore's durability — Safari's ITP, storage-pressure eviction, and "clear browsing data" can all wipe it, none of which apply to hardware-backed Android storage. Rather than pretending the web identity is as durable as the Android one, the device table treats it defensively: each web device sends a lightweight signed heartbeat on every session refresh (piggybacked on the existing 15-minute token refresh, no new traffic). If a web device's heartbeat goes silent for **14 days**, its row is auto-transitioned to `expired` (not `revoked` — this is routine cleanup, not a trust event, so it does *not* trigger the device-list-changed banner in §4 or get treated as a security incident) and its slot in the ≤2-devices-per-person model frees up. If the browser storage was actually evicted, the person just logs in again via OTP and gets a fresh device row; if it wasn't, the heartbeat keeps the row alive indefinitely.

- **Session storage (Next.js web client)**: standard token pair — short-lived signed access token (15 minutes) plus a long-lived refresh token, both delivered as secure, `httpOnly`, `SameSite=Strict` cookies. The refresh token is rotated on every use, capped at 30 days.

- **Device table & revocation**: one row per device in the SQLite device table, `status: active | revoked | expired`.
  - **Revoke one device**: mark it revoked, delete its stored prekeys server-side (§6), invalidate any outstanding tokens tied to that device, **and (v5 fix) immediately call LiveKit's `RemoveParticipant` API for that device's identity if it currently holds a live room connection.** This is the piece v4 was missing: token-status checks only run when a client *establishes* a new connection, so a device already mid-call or holding an open signaling WebSocket was never actually kicked. The revoke handler now does both: DB status flip (blocks future connections) + active-session teardown (ends the current one), so "lost my phone, still trust me" is closed for both the case where the phone is offline and the case where it's mid-call.
  - **Revoke a person**: cascades — sets every one of their devices to revoked; the single-device logic above (including the live-session teardown) runs for each one.
  - **Making it take effect immediately, not eventually**:
    - *Auth side*: token validation includes a cheap lookup of the device's `status` in SQLite, not just signature+expiry, so a revoked device can't ride out a token's remaining lifetime even for a new connection attempt.
    - *Live-session side (v5 fix, closes the real gap)*: the `RemoveParticipant` call above, fired synchronously as part of the revoke transaction — not a background job, so there's no window between "marked revoked" and "actually disconnected."
    - *Encryption-trust side*: each user has a device-list version counter. Any add/revoke/expire bumps it. On bump, the wake service (§10.2) delivers a "device list changed for user X" event over **whichever channel is currently live — WS if connected, FCM otherwise** (v5: same dual-channel fix as call-wake, §10.2). Receiving clients invalidate their cached key for that user and refetch, surfaced as a **visible banner**. Routine `expired` transitions (web-heartbeat timeout) are excluded from this banner — only `revoked` is a trust event worth surfacing.
  - **Revocation event log (v5 fix, closes the DR interaction gap)**: every revoke — device or person — is written to an **append-only log in R2** at the moment it happens, independent of the nightly SQLite backup. See §11 for how this is replayed during disaster recovery so a restore-from-backup can't silently resurrect a device revoked after the last snapshot.

- **Concurrency gate**: LiveKit's native `max_participants` (5) enforced server-side.
- **Known-members cap**: the same allowlist that gates OTP issuance doubles as the ≤10 cap.

---

## 5. Data Saver / Adaptive Quality

| Technique | What it does |
|---|---|
| **Simulcast** | Each camera publisher sends 2–3 quality layers simultaneously (e.g., 180p/360p/720p); the SFU forwards only the layer each receiver's link can sustain. |
| **Dynacast** | LiveKit pauses simulcast layers that no subscriber is currently using. |
| **Adaptive stream** | Receiver-side: LiveKit reduces subscribed resolution automatically when a video tile is small/off-screen. |
| **Audio DTX + Opus** | Near-zero bitrate during silence. On by default with Opus, worth confirming it's enabled. |
| **Explicit "data saver" toggle** | A UI switch that caps outgoing resolution/fps and/or drops to audio-only. |
| **Audio-only fallback mode** | One tap to disable video entirely and keep the call alive on audio. |

---

## 6. End-to-End Encryption

- **Already present regardless**: WebRTC mandates DTLS-SRTP — media is encrypted in transit, including on the hop through the SFU.
- **What E2EE adds**: without it, the SFU server itself (whatever box it's running on — local Docker host today, wherever production ends up per §1a — or anyone with root on it) *can* technically decrypt media, since it terminates DTLS to do its forwarding job. E2EE closes that gap.

**Approach**: the **Signal Protocol** (X3DH key agreement + Double Ratchet) — the same protocol used for messaging (§10.4), now the single unified key-agreement layer for calls too.

- The two devices' existing Signal Protocol session produces the shared secret via its Double Ratchet, which advances automatically.
- That derived key feeds **WebRTC Insertable Streams / SFrame** for actual frame encryption. LiveKit still forwards opaque encrypted frames; it never sees the session or the derived key.

**Prekey endpoint auth**: `GET /prekeys/{userId}/{deviceId}` requires a valid session — the same access token used everywhere else, no unauthenticated fetch.

### 6.1 Group call key management: who rotates the room key, and when

Calls with more than two people need a **room key** — a symmetric key shared across all current participants for SFrame frame encryption — distributed pairwise over each participant's existing Signal Protocol session, and rotated on join/leave.

**Rotation is deterministic, not elected.** Define the responsible party as the remaining participant with the earliest join time (from LiveKit room state). Every client computes this locally — no coordination round-trip. Ties break by participant identity string sort.

**Consistency check**: each client computes a short fingerprint — first 4 hex characters of SHA-256 of the room key — displayable in the call UI.

**Recovery on mismatch (v5 fix)**: v4 stopped at detection. Now, when a client detects its fingerprint doesn't match the majority (>50%) of other visible fingerprints after a rotation:
1. It silently triggers **one automatic re-rotation** using the same deterministic earliest-joiner logic — this covers the common case (a stale key from a race during simultaneous join/leave) without bothering anyone.
2. If fingerprints still disagree after that single retry, the client stops silently retrying and instead surfaces an explicit **"call needs a moment — rejoin"** prompt, the same pattern as Signal's safety-number-changed flow: a deliberate action rather than a silent loop, so a real mismatch (bug, tampering, or a truly wedged client) doesn't manifest as an indefinite retry storm or a call that's mysteriously broken for one participant with no explanation.

**Caveat to flag honestly**: enabling E2EE means the SFU can no longer transcode content, only forward pre-encoded layers — this is a "verify in testing" note, not a blocker.

---

## 7. NAT Traversal & Russia-Specific Reliability

This is the section worth spending real effort on — a dropped/unreliable call matters more than almost anything else here.

**v6 precondition**: everything below assumes the box is reachable from the public internet on the ports in §8. On local Docker (§1a) that's not automatic — it requires port-forwarding or a tunnel first. Nothing in this section changes once that's in place; it's a prerequisite, not a redesign.

### 7.1 Layered relay strategy (v5: priority order corrected)

| Layer | Detail |
|---|---|
| STUN | Multiple STUN servers configured, so address discovery doesn't depend on a single host being reachable. |
| Host / srflx (direct) | Tried first, per standard ICE candidate priority — no override. |
| TURN/UDP | Standard relay fallback, port 3478 — tried before TCP relay under normal ICE priority ordering, since UDP relay has lower latency/jitter than TCP relay. |
| **TURN/TLS on 443** | **v5 fix**: no longer forced as first-preference. It remains a configured candidate — required because Russian DPI can and does block raw UDP outright, at which point it's the only path that works, wrapped in TLS on 443 so DPI sees generic HTTPS. But it's left to normal ICE priority (which ranks it below UDP-based candidates) rather than artificially promoted above them. Net effect: the *best available* path wins when the network allows it; TCP/443 activates automatically, without special-casing, exactly when UDP is actually blocked — which is the situation it's meant to solve. This matches §1's stated priority (no jitter over infra simplicity) instead of quietly working against it. Handled by a standalone coturn instance, reached via nginx's `ssl_preread`-based stream demux on 443. |
| ICE restart | LiveKit supports automatic ICE restart on connection degradation. |

**Hard constraint: every ICE server entry must use the hostname, never a bare IP.** SNI demux only works if the ClientHello carries `turn.yourdomain.com`. Both the LiveKit server config and the Android/web client SDK config must set the TURN entry as `turns:turn.yourdomain.com:443?transport=tcp`. This fails **silently** if misconfigured. Add a deploy-time check: a CI step that greps the LiveKit config and client build config for any ICE server entry matching a bare IPv4/IPv6 pattern and fails the build if found.

### 7.2 Geographic/path redundancy — decided against, for now
Not building a second geo-distributed TURN relay now. Revisit only if real-world testing shows a consistently bad path.

### 7.3 Monitoring, not just redundancy
- LiveKit emits connection-quality events and stats (packet loss, jitter, RTT) — surface these to a simple dashboard or console-log/alert on sustained "poor."
- Log which ICE candidate type won each call (host / srflx / relay-UDP / relay-TCP) — over a few weeks this tells you empirically which path Russia's network actually prefers, and specifically how often TCP/443 activation was actually necessary versus UDP working fine.

---

## 8. Deployment Footprint (v6: Local Docker Compose, for now)

- **LiveKit server**: single binary, moderate RAM/CPU at this scale. LiveKit does no transcoding (forwarding only) so load is mostly network I/O.
- **coturn**: lightweight relative to LiveKit; adds modest CPU during active relayed calls.
- **Auth service + SQLite**: negligible footprint at ≤10 users.
- **Redis**: **required (v5 fix — no longer "optional")**. Holds LiveKit room state across restarts/deploys; also the natural place to track wake-service WS connection liveness (§10.2). Given DR now depends on a clean restart sequence (§11), an undefined Redis dependency was the wrong thing to leave ambiguous.
- **Wake service**: new, lightweight — holds persistent authenticated WebSocket connections for the fallback wake path (§10.2). Effectively stateless beyond Redis-tracked connection liveness.
- **Ports**: 443 (HTTPS/WSS signaling + TURN/TLS via SNI demux), 3478 (TURN/UDP+TCP), 7881 (LiveKit's default WebRTC/TCP fallback), a narrowed UDP relay range. On local Docker these are container-mapped ports; see §1a for the port-forward/tunnel question that determines whether they're reachable from outside the home network at all.
- **Isolation from truestele.com (v6: not applicable for now)** — this was a Hetzner-specific co-location concern from sharing one VPS with another site. Local Docker isn't sharing that host, so this constraint drops out until/unless a production hosting decision reintroduces it (§1a).
- **Resource headroom**: no longer bounded by a CX23's fixed vCPU/RAM — bounded by whatever the operator's local machine has free, and by that machine also needing to stay usable for everything else it's doing day-to-day. Worth a rough sanity check (§13, Phase 1) even without a rigid spec to hold against.
- **Secondary relay (§7.2)**: not built now.

**Capacity validation — a rollout step, not a redesign.** With truestele.com out of the picture (v6), the local-Docker version of this check is simpler: run a real 5-participant video call plus normal messaging load on the actual machine the stack runs on, and watch CPU/memory headroom during it. If the machine's tight, that's a scaling/hosting question — see §1a — not evidence the architecture is wrong.

---

## 9. Security Notes

- DTLS-SRTP for all live-call media (mandatory, unconditional) + Signal Protocol-derived frame encryption on top (§6).
- Signal Protocol is the single key-agreement backbone across calls, messages, voice notes, and files (§6, §10.4).
- TLS everywhere in the control plane (signaling, TURN/443, messaging service, dashboards).
- Short-lived, room-scoped JWT tokens instead of static shared credentials, backed by the live device-status check in §4, **plus synchronous live-session teardown on revoke (v5 fix, §4)** — a revoked device can't ride out its token's remaining lifetime *or* stay connected to a room it was already in.
- OTP-gated allowlist login (§4) plus per-device and per-person revocation, with the revocation event also logged off-box in real time (§4, §11) so a disaster-recovery restore can't undo it.
- Server-enforced `max_participants` — capacity can't be bypassed by a modified client.
- No call recording/persistence by default; room state is ephemeral.

**Accepted external-dependency risk (v5, new — closes the "never risk-assessed" gap)**: this design leans on several Western services with no built-in fallback beyond the FCM one addressed in §10.2. Listed explicitly here instead of left implicit:

| Dependency | What breaks if it's unreachable from Russia | Mitigation status |
|---|---|---|
| FCM (call wake, device-list push) | Incoming calls/revocation events don't arrive | **Mitigated (v5)** — persistent WS fallback, §10.2 |
| Transactional email (OTP delivery) | Login blocked | Accepted risk — not mitigated. A blocked login is inconvenient but not a dropped call; lower priority than the live-call path per §1. |
| Cloudflare R2 (message/voice-note storage, revocation log, backups) | Async messaging and DR both degrade | Accepted risk — not mitigated. R2 is a large, general-purpose CDN-adjacent service, materially less likely to be individually targeted than a narrow app-specific host; revisit if real-world testing shows otherwise. |
| GitHub Releases (Android app updates) | App can't self-update | Accepted risk — not mitigated. Stale-but-functional app is a soft failure, not a call-quality or availability failure. |

This table is the honest version of what v4 left unstated: these are conscious trade-offs given the ≤10-user scale and the stated priority (call reliability over infra completeness), not oversights — but they're now written down rather than silently assumed to "just work."

---

## 10. Scope Correction: These Are Goals, Not Non-Goals

You want a real WhatsApp-for-two experience — native Android app, a Next.js web client, accounts, the works.

### 10.1 Two native-ish clients: Kotlin (Android) + Next.js (web)
- **Android**: native Kotlin, using LiveKit's Android SDK directly — full control over ConnectionService/Telecom integration (§10.2).
- **Web**: Next.js, using LiveKit's JS SDK. Session via the cookie model in §4, identity via the persistent (heartbeat-defended, v5) device identity in §4.
- **On the "apps get banned" concern**: the Android app sidesteps this by sideloading the APK directly, no Play Store listing needed. No Apple/iOS leg to worry about.
- Both clients hit the same backend — no server-side duplication, just two frontends.

### 10.1a CI/CD & OTA updates via GitHub
- **Android**: GitHub Actions builds the APK on push/tag → publishes to a GitHub Release. The app checks the Releases API on launch, compares version tags, prompts to update.
- **Web (Next.js)**: GitHub Actions builds and deploys on push/tag — Vercel, or self-hosted alongside the rest of the stack (local Docker for now, wherever §1a lands for production).
- Net effect: `git push`/tag → Android gets a GitHub Release the app pulls itself, web redeploys automatically.

### 10.2 Incoming call experience (the actual "WhatsApp feel") — v5: dual-channel wake

- **Push notifications to wake the app for an incoming call**: **FCM remains primary** — the auth/signaling service triggers a push when one of you starts a call.
- **v5 fix — WS fallback, not FCM-only**: the wake service (§3, §8) also maintains a lightweight persistent, authenticated WebSocket from each active client. When a call starts or a device-list-changed event fires, the service delivers over **whichever channel is currently live** — direct over the WS if the client holds one open, FCM otherwise (both may fire; the client dedupes). This closes the single-point-of-failure v4 left unaddressed: FCM being degraded or blocked from the Russia side no longer means no call can ever start, as long as the app is foregrounded and holding its WS connection (which it now reliably does — see below).
- **Native call UI**: Android **ConnectionService/Telecom** integration gives the real lock-screen incoming-call ring + accept/decline UI.

**10.2a Foreground-service notification — the trade-off, the default, and why it now enables the WS fallback above.** Keeping the call/FCM listener alive reliably on Android generally means a persistent foreground-service notification.
- §7's TURN-on-443 effort protects against a **network operator** observing traffic patterns — a nation-state-adjacent threat model.
- A foreground-service notification is only visible to someone with **physical access to the unlocked phone**. It changes nothing about what a network observer sees.

Default: **accept the notification** — a low-key "Messaging active" notice, same pattern Signal/WhatsApp/Telegram use. This is the one open decision left in this doc: if physical-device discretion from someone with access to the phone *is* a real concern for either of you, the answer flips to "skip the foreground service, FCM-only with monitored miss-rate, no WS fallback" — a policy call resting on a fact about your physical situation, not something the architecture can resolve on its own. **Note (v5): choosing the discretion-first option also gives up the WS fallback above**, since it depends on the same always-alive foreground process — worth knowing that's the actual cost of that choice, not just "one fewer notification."

### 10.3 Account system
- "Accounts" means persistent identity + device registration (§4), not a passcode typed fresh each time.
- Device token registration at login time, so push/WS notifications (§10.2) know where to deliver.

### 10.4 Voice notes & file transfer — underlying architecture
Genuinely separate from the call stack in §2–8 (those handle *live* media; this handles *stored/async* content):

- **Why it can't just reuse the SFU**: LiveKit's data channels only work while both of you are in an active room together. A voice note or file sent while she's offline needs actual server-side storage and a delivery queue.
- **Transport, two paths**: both online → direct WebRTC data channel; recipient offline → store-and-forward via server-side storage, push a notification (dual-channel, §10.2) when they come online.
- **Storage**: Cloudflare R2, delete-after-both-downloaded, **7-day maximum retention** via an R2 lifecycle rule.
- **Encryption at rest on R2**: blob encrypted client-side before upload, per-file symmetric key wrapped by the same Signal Protocol session (§6). R2 only ever stores ciphertext.
- **Voice notes**: recorded client-side (`MediaRecorder`), encoded Opus, sent through the same file-transfer pipeline, tagged for UI treatment.
- **Encryption — different scheme than §6, deliberately**: Signal Protocol (X3DH + Double Ratchet) for messages/files/voice notes, SFrame for live media — two independent, purpose-appropriate schemes, matching WhatsApp's own split.
- **Data saver interaction (§5)**: client-side compression/resolution capping before upload.

### 10.5 Messaging: text, images, video, stickers, GIFs

| Content type | Notes |
|---|---|
| **Text** | Signal-Protocol-encrypted payload type. |
| **Emoji** | Native Unicode via Android's system font/keyboard. |
| **Stickers** | Gboard's built-in sticker support via Android's keyboard-integration API. |
| **GIFs** | Third-party API (Tenor/Giphy) — the one point in this design that isn't fully self-hosted/private, a reasonable trade-off for convenience. |
| **Images & video** | Same store-and-forward/P2P pipeline as voice notes, plus client-side thumbnailing/compression, original-quality fetchable later. |

---

## 11. Disaster Recovery

Target: recovery from a lost/failed host in **under an hour**. v5 made this a real, testable procedure — see `docker-compose.yml` and `REDEPLOY-RUNBOOK.md` alongside this doc — rather than a reference to a playbook that didn't exist.

- **IP (v6: not applicable yet)** — the Floating-IP mechanism below is Hetzner-specific and doesn't apply to a local Docker deployment, which has no stable public IP of its own to begin with (§1a). For now, "recovery" means: restore the Docker volumes (SQLite snapshot + Redis data) from backup and run `docker-compose up` again on the same or a replacement local machine — no IP reassignment step exists yet. This section's Floating-IP mechanics become relevant again once a production hosting decision (§1a) is made; they're kept here rather than deleted so v6 doesn't lose the recovery design that'll be needed then.
- **TLS certs (v6: deferred)** — Let's Encrypt/acme.sh issuance needs a publicly reachable, stable hostname, which depends on §1a's still-open port-forward/tunnel decision. Until that's resolved, local-Docker testing runs without public TLS (e.g., self-signed certs or plain HTTP on the LAN); the "issue cert as an explicit runbook step" logic below still applies once §1a is settled.
- **Backup decryption key custody**: the `age` key encrypting the nightly SQLite backup must **not** live only on the machine running the stack (local Docker host today). Primary copy in a password manager maintained outside this system, plus one offline fallback (printed, or a physically separate USB key). Never store the decryption key in the same R2 bucket as the encrypted backups.
- **Revocation-log replay (v5 fix — closes the backup/revocation interaction gap)**: the nightly SQLite snapshot can be up to 24 hours stale, and a device revoked *after* the last snapshot but *before* the box died would otherwise come back `active` on restore. The runbook now requires: after restoring the SQLite snapshot, **replay every entry in the R2 revocation log with a timestamp newer than the snapshot** before the auth service starts accepting connections. Since the revocation log is written in real time (§4) rather than nightly, this closes the gap regardless of how long the box was down or how stale the snapshot was.
- **Redeploy pipeline (v5 fix — closes the "playbook that's never specified" gap)**: `docker-compose.yml` defines every service in §3/§8 (nginx, coturn, LiveKit, Redis, auth service, wake service, messaging service) as a reproducible stack. `REDEPLOY-RUNBOOK.md` is the step-by-step. **v6, local-Docker version**: restore SQLite snapshot + replay revocation log → bring up the compose stack → health-check → open to LAN/tunnel traffic (no floating-IP or acme.sh step yet — see above). The production version of this runbook, with IP reassignment and cert issuance restored, is written once §1a is resolved. Either way, this is what makes "under an hour" a claim that can actually be rehearsed and timed, not an assumption.

---

## 12. Status

Accurate as of v6:

- **Resolved in v5**: revocation reaching an already-live session (§4/§9), the nightly-backup/revocation interaction (§4/§11, via real-time revocation log + replay), web device identity storage fragility (§4, via heartbeat + auto-expiry), FCM as an unmitigated single point of failure (§10.2, via WS fallback), key-rotation mismatch having no recovery path (§6.1, via auto-retry + rejoin prompt), the Redis optional/required inconsistency (§8), and the DR redeploy playbook not actually existing (§11, now `docker-compose.yml` + `REDEPLOY-RUNBOOK.md`).
- **Also resolved in v4 and carried forward**: persistent web identity, per-device revocation's DB/token/encryption-trust layers, room-key rotation successor logic's deterministic assignment, the TURN hostname/SNI-demux constraint, IP/cert sequencing, OTP email delivery, prekey endpoint auth, OTP rate limiting.
- **v6 change, not a gap**: hosting moved from Hetzner CX23 to local Docker Compose for now (§1a). Everything hosting-independent (§2–§9) is unaffected; §3/§8/§11 are updated for the new deployment target.
- **Open decision #1 (carried forward)**: §10.2a's foreground-notification trade-off — and specifically that choosing the discretion-first path also gives up the WS wake fallback, not just the notification itself. Depends on a fact about your physical environment only the two of you know.
- **Open decision #2 (new in v6)**: §1a's public-reachability question — port-forward vs. tunnel — needed before real calls (not same-LAN testing) work over the local Docker stack. Scheduled as a Phase 1 decision (§13).
- **Accepted, not mitigated, and explicit rather than implicit (§9)**: transactional-email OTP delivery, Cloudflare R2, and GitHub Releases remain single Western-infrastructure dependencies with no fallback built. This was a conscious scope call given the ≤10-user scale, not an oversight — v5 wrote it down explicitly, and it's unaffected by the v6 hosting change.

See §13 for the phase-by-phase build sequence and what marks each phase done.

---

## 13. Implementation Phases

Ordered by dependency — each phase assumes the ones before it are done. "Done" means the bar below is actually met, not just that code exists for it; that's what makes a phase a checkpoint instead of a vibe.

### Phase 0 — Local environment foundation
Docker Compose skeleton with nginx (SNI stream-demux configured), coturn, and placeholder services for everything in §3, all running locally. Domain/hostname strategy stubbed (real value depends on §1a).
**Done when**: `docker-compose up` brings up every service in §3 with no crash loops, and nginx's stream demux correctly routes a test TURN handshake to coturn versus regular HTTPS to the app — verified locally, reachability from outside not required yet.

### Phase 1 — Core SFU + minimal auth (walking skeleton)
LiveKit + Redis wired in; bare-bones auth service with SQLite (allowlist + OTP + JWT room tokens). **§1a's reachability decision (port-forward vs. tunnel) gets made and implemented here**, since nothing past this phase can be tested from Russia↔India without it.
**Done when**: two physically separate devices — one on each side of the actual India/Russia link — OTP-login and hold a 1:1 audio+video call routed through TURN/TLS on 443, end to end, not just on the same LAN.

### Phase 2 — Access control & revocation
Full device table (`active/revoked/expired`), per-device and per-person revoke, synchronous `RemoveParticipant` teardown, device-list version counter + banner, web-identity heartbeat/auto-expiry.
**Done when**: revoking a device that's mid-call actually disconnects it within a couple seconds (not just blocks its *next* login), and the other party sees the device-list-changed banner without refreshing.

### Phase 3 — Call quality & Russia-path reliability
Simulcast/Dynacast/adaptive stream, corrected ICE priority ordering (TURN/TLS as fallback, not forced-first), ICE restart, data-saver toggle, audio-only fallback, connection-quality logging/dashboard.

**Implemented** (see `testing/webrtc-harness/`, `services/auth-service/app/quality.py` + `routers/quality.py`, migration `003_phase3_quality_log.sql`):
- Simulcast (3 layers: 180p/360p/720p) + Dynacast + adaptive stream, enabled via the LiveKit JS SDK's `publishDefaults`/room options.
- ICE priority ordering — already correct at the infra layer (nginx/coturn, §7.1's v5 fix): TURN/TLS-443 is a configured candidate but not forced first, so UDP wins when available and TURN/TLS activates automatically only when it's genuinely needed.
- ICE restart — handled by the LiveKit JS SDK's own reconnect policy; the harness surfaces `Reconnecting`/`Reconnected` events and logs the post-reconnect candidate pair.
- Data-saver toggle — forces remote video subscriptions to LOW quality and republishes local video at a reduced resolution preset (not just a UI label).
- Audio-only fallback — unpublishes local video; auto-triggers after a run of sustained `Poor` connection-quality events, in addition to manual toggle.
- Connection-quality logging/dashboard — the harness POSTs periodic snapshots (quality enum, winning ICE candidate type, relay protocol, RTT/jitter/loss) to `/auth/quality/report`; view them at `/auth/quality/dashboard`.

**Validation strategy (revised from v6)**: originally scoped as "a week of real calls on the actual link" — dropped in favor of local, repeatable emulation, since it doesn't depend on the counterparty's location or a finished client. Uses `scripts/network-emulation.sh` (host-level tc netem + iptables, keyed by one peer's LAN IP — asymmetric delay/jitter/loss, and simulated DPI-style UDP blocking that forces the TURN/TLS fallback) and `scripts/toxiproxy-scenarios.sh` (scripted, timed cuts on the TURN/TLS-443 path specifically, for on-demand ICE-restart testing) against two instances of `testing/webrtc-harness/` on the local docker-compose stack.

**Done when**: running the harness from two tabs against the local stack, with `network-emulation.sh` applying Russia-representative latency/jitter/loss + UDP blocking to one peer and `toxiproxy-scenarios.sh cut` triggering at least one scripted TURN/TLS outage mid-call, the call recovers via ICE restart without a full drop, and the quality dashboard shows the correct candidate type (relay, with `tls` protocol) for the duration of the simulated block.

### Phase 4 — End-to-end encryption
Signal Protocol (X3DH + Double Ratchet) as the shared key-agreement layer, SFrame frame encryption for calls, deterministic room-key rotation for group calls, prekey endpoint auth.
**Done when**: a call's SFrame key fingerprint (§6.1) matches on both ends for a 1:1 call and for a 3+ participant call including a mid-call join/leave, verified by actually comparing the displayed fingerprints — not just "it connected."

### Phase 5 — Native clients + wake system
Android Kotlin app (LiveKit SDK, ConnectionService/Telecom), Next.js web client, wake service with dual-channel (FCM + persistent WS) delivery, CI/CD via GitHub Actions/Releases.
**Done when**: an incoming call rings on the Android lock screen via the native call UI, delivered over WS when the app holds one open and over FCM as a real fallback (tested by actually blocking FCM and confirming the WS path alone still delivers the call).

### Phase 6 — Messaging & async content
Signal-Protocol-encrypted text/images/video/voice notes, R2 store-and-forward, client-side compression/thumbnailing, GIF/sticker integration.
**Done when**: a voice note sent while the recipient's device is fully offline (not just backgrounded) arrives and plays after they come back online, and the R2 blob is confirmed deleted after both sides have downloaded it.

### Phase 7 — Disaster recovery & ops hardening
`docker-compose.yml` finalized, `REDEPLOY-RUNBOOK.md` written for the current (local-Docker) hosting target, backup key custody in place (password manager + offline fallback), revocation-log replay on restore.
**Done when**: someone actually executes the runbook against a simulated failure (kill the stack, restore from backup on a different machine) and it comes back with the revocation log correctly replayed — timed, not just read through.

### Phase 8 — Launch validation
Capacity check under real load, redeploy rehearsal, final sign-off on the §9 accepted-risk table and the §10.2a foreground-notification decision, and — if it hasn't already forced itself in earlier — the production hosting decision deferred in §1a.
**Done when**: the 5-participant call + messaging + local-machine-load test in §8 runs clean, the Phase 7 rehearsal has a real "under an hour" number attached to it, and both open decisions in §12 have been made (not just noted) by the two of you.
