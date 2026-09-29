# wake-service

Reaches a device that is not currently connected, so a message or a call
arrives when the app is closed.

Without this, the web client only notifies while its tab is open — which is
the honest limit of a page with no service worker, and was the largest
functional gap between this and any other messenger.

## What it does

`messaging-service` stores a message for every recipient device and pushes it
down whichever delivery sockets are live. For a device with no live socket,
store-and-forward applies and the message simply waits — and nothing tells the
member. That service now calls `POST /wake` for exactly those devices, and
this one sends a Web Push to each.

## The payload carries nothing

What travels inside the sealed push body is `{"v":1,"r":"message"}`. No
sender, no chat, no message id, no preview, no count.

The service worker is told only that *something* arrived, and then reads the
real thing from the encrypted store itself and decrypts it locally. Anything
richer would put message metadata in a log at Google or Mozilla, which is the
one thing a push-based notification is tempted into and the reason the naive
version of this feature is a privacy regression rather than a feature.

`r` is the single concession: a ring has to produce a different notification
from a text, and the worker cannot know which without being told. A push
service learns "something arrived for this subscription at this second" from
the request itself regardless of what the body says.

## The parts

| File | What |
|---|---|
| `app/webpush.py` | RFC 8291 message encryption, with RFC 8188 framing |
| `app/vapid.py` | RFC 8292 application-server identification, and the keygen CLI |
| `app/sender.py` | The POST to the push service, and the endpoint allowlist |
| `app/subscriptions.py` | Where to reach each device, and nothing else |
| `app/routers/wake.py` | `POST /wake`, called by messaging-service only |

`webpush.py` is written out rather than taken from a library because the whole
path is "encrypt, POST, and never find out whether it worked": a push service
answers 201 to a body it cannot decrypt, and a transposed derivation step
shows up only as notifications that silently never arrive. The suite pins it
against the worked example published in RFC 8291 §5, so it is checked against
the spec and not merely against itself.

## Setting it up

Generate the keypair once:

```bash
cd services/wake-service && python -m app.vapid keygen
```

Put both lines in `.env`, along with a contact address the push service
operator can reach and a shared secret for the internal call:

```
WAKE_VAPID_PRIVATE_KEY=...
WAKE_VAPID_PUBLIC_KEY=...
WAKE_VAPID_SUBJECT=mailto:you@yourdomain.example
WAKE_INTERNAL_SECRET=...
```

Rotating the keypair invalidates every existing subscription — a browser
refuses a push signed by a key it did not subscribe with — so treat it as
long-lived state, not a rotating secret. Members re-subscribe on next load.

The service refuses to start without all four. A missing VAPID key is not a
degraded mode: every push would be rejected, silently, forever.

## What is not here

**The §10.2 persistent-WS fallback.** The design doc pairs FCM with a
lightweight authenticated WebSocket so one Google outage cannot block every
call. For the web client that second socket already exists — it is
`messaging-service`'s delivery socket, which is live whenever the tab is —
so building another one here would be duplicate machinery serving no case the
first does not already cover. The fallback belongs with the Android client,
which is where a *native* FCM path and its outage actually matter.

**FCM's own HTTP v1 API.** Web Push to Chrome goes through `fcm.googleapis.com`
as a standard RFC 8030 endpoint, no Firebase project required. Android will
need the FCM API proper; that arrives with the Android client.

## Tests

```bash
cd services/wake-service && python -m pytest tests -q
```
