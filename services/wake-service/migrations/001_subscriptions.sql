-- §10.2: where to reach a device that is not currently connected.
--
-- One row per device, not per member: a wake goes to the device that is
-- missing the message, and a member's laptop and phone hold entirely separate
-- push subscriptions. Re-subscribing replaces the row (device_id is the
-- primary key), because a browser may hand out a new endpoint for the same
-- device at any time and the old one then 410s forever.
--
-- `endpoint` is a URL at the browser vendor's push service. `p256dh` and
-- `auth` are that subscription's public key and auth secret, base64url as the
-- browser produced them; together they let this service seal a payload the
-- push service itself cannot read (RFC 8291). None of it is secret from the
-- member -- it is all values their own browser generated and handed over.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    device_id    TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    endpoint     TEXT NOT NULL,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    -- Bumped on every successful push, so a stale row is visible as such
    -- without keeping a log of what was sent or when it was read.
    last_push_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_email
    ON push_subscriptions (email);
