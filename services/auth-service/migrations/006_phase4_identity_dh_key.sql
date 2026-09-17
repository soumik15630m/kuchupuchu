-- Phase 4 follow-up: X3DH needs identity keys that are usable in a
-- Diffie-Hellman operation (the DH1/DH2 terms in the X3DH spec use IKa
-- and IKb directly). 004's identity_keys.public_key is Ed25519 --
-- deliberately, so it doubles as a stable value for §9's safety-number
-- display and signs the signed prekey -- but Ed25519 keys aren't X25519
-- keys, and converting one to the other safely needs point-arithmetic
-- this codebase has no reason to hand-roll.
--
-- So: a second, DH-capable identity key, cross-signed by the Ed25519
-- identity key it belongs to. A bundle isn't complete for X3DH purposes
-- until both rows exist for a device.
CREATE TABLE IF NOT EXISTS identity_dh_keys (
    device_id   TEXT PRIMARY KEY REFERENCES devices(id),
    -- base64-encoded 32-byte X25519 public key.
    public_key  TEXT NOT NULL,
    -- base64-encoded 64-byte signature: identity_keys.public_key (the
    -- Ed25519 key for this same device_id) signing this row's public_key
    -- bytes. Same verify-on-upload posture as signed_prekeys.signature.
    signature   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
