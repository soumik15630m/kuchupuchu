-- Phase 4 (§6, §13): prekey storage for X3DH key agreement.
--
-- This only stores public material a device chooses to publish -- private
-- keys never leave the client. One identity key per device, one active
-- signed prekey per device (replaced wholesale on rotation, no history
-- kept), and a pool of one-time prekeys consumed one-per-bundle-fetch.

CREATE TABLE IF NOT EXISTS identity_keys (
    device_id   TEXT PRIMARY KEY REFERENCES devices(id),
    email       TEXT NOT NULL,
    -- base64-encoded 32-byte Ed25519 public key. This is the long-term
    -- identity key XEdDSA-signs the signed prekey with; §9's safety-number
    -- story depends on this never silently changing under a device_id, so
    -- app/prekeys.py refuses to overwrite an existing row rather than
    -- treating this table as upsert-on-every-login.
    public_key  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signed_prekeys (
    device_id   TEXT PRIMARY KEY REFERENCES devices(id),
    key_id      INTEGER NOT NULL,
    -- base64-encoded 32-byte X25519 public key.
    public_key  TEXT NOT NULL,
    -- base64-encoded 64-byte signature: identity_keys.public_key signing
    -- this row's public_key bytes. Verified server-side on upload
    -- (app/prekeys.py) so a malformed bundle never gets served to a peer.
    signature   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL REFERENCES devices(id),
    key_id      INTEGER NOT NULL,
    public_key  TEXT NOT NULL,
    -- NULL until consumed by a bundle fetch. Consumed rows are kept
    -- (not deleted) so a re-sent fetch can be told "already used" instead
    -- of silently handing out a second bundle without a one-time key.
    used_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (device_id, key_id)
);

-- Bundle fetches filter on (device_id, used_at IS NULL) to find the next
-- unconsumed key; uploads filter on (device_id, key_id) to reject
-- resubmitting an id the device already published.
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_unused ON one_time_prekeys(device_id, used_at);
