-- Phase 2 (§4, §13): access control & revocation.
--
-- The `devices` table itself already exists (001_init.sql) — Phase 1 only
-- needed enough of it to mint tokens. This migration adds what revocation
-- and the "device-list changed" banner need on top of it.

-- One row per email (not per device). Bumped on every add/revoke/expire of
-- one of that person's devices (§4). Clients poll this to know when to
-- invalidate a cached contact and show the device-list-changed banner.
-- Routine `expired` transitions (web-heartbeat timeout) deliberately do NOT
-- bump this — only `revoked` and new-device-add are trust-relevant (§4).
CREATE TABLE IF NOT EXISTS device_versions (
    email       TEXT PRIMARY KEY,
    version     INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (email) REFERENCES allowlist(email)
);

-- Revocation and the auto-expiry sweep both filter by status; this was a
-- full-table scan before.
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
