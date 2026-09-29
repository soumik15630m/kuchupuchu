# web client

Next.js + TypeScript. Calls, messaging, and theming for the group described in
`docs/design-doc-v6.md` §10.1.

Messaging (design-doc Phase 6) was deliberately pulled forward into this
build, so §13's Phase 5/6 split no longer matches what is here.

## Running it

```bash
npm install
npm run dev
```

Needs `auth-service` and `messaging-service` reachable. Defaults assume nginx
in front of them (`/auth`, `/msg`, `/wake`); point elsewhere with
`NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_MSG_BASE` and `NEXT_PUBLIC_WAKE_BASE`.

```bash
npm test          # node:test, pure modules only
npm run typecheck
npm run build
```

## How it is laid out

| Path | What |
|---|---|
| `src/app/` | Routes. App Router, one directory per screen. |
| `src/components/` | Everything rendered. `chat/`, `call/`, `shell/`, `ui/`. |
| `src/lib/crypto/` | X3DH, the Double Ratchet, group keys, identity pinning. |
| `src/lib/messaging/` | The client, the store, and the pure rules around them. |
| `src/lib/call/` | LiveKit engine, E2EE wiring, call log, picture-in-picture. |
| `src/lib/backup/` | Passphrase-encrypted archive, scheduling, restore. |
| `src/lib/push/` | Service-worker registration and the push subscription. |
| `src/lib/theme/` | Theme, wallpaper, and the cross-device sync. |
| `public/sw.js` | The service worker. Wakes for a push; deliberately does not decrypt. |
| `src/proxy.ts` | The per-request CSP. Named `proxy.ts`, not `middleware.ts` — Next 16 renamed it. |

Logic that can be tested without a browser lives in a `.mjs` module beside a
`.d.mts` for the types, with tests in `test/`. That is why the ratchet, the
swipe arithmetic, the presence wording and the backup envelope are all plain
modules rather than hooks: the rules are the part worth pinning.

## Things that will bite

**`worker-src blob:` in `src/proxy.ts` is load-bearing.** Remove it and
livekit-client cannot build its frame-cryptor worker, the call engine falls
back to `worker = null`, and calls proceed **unencrypted** with nothing in the
UI saying so.

**`rtcConfig` is a `connect()` option, not a `Room` option.** Passed to
`new Room({...})` it is silently discarded and the TURN list never reaches
the peer connection. `dynacast` is the opposite — a Room option that is
silently dropped inside `publishDefaults`.

**The ratchet must not advance before the AEAD verifies.** `message-ratchet.js`
snapshots and rolls back on a failed decrypt; without that a redelivered
envelope desynchronises the chain permanently.

**Local data belongs to one member.** `lib/auth/local-data.ts` decides, proves,
then destroys — a wipe must never happen before the login is authenticated.

**Notifications come from two places.** The page shows the rich ones; the
service worker shows a contentless one when no page is running. They never
both fire: the worker pings first and stays quiet if anything answers.
