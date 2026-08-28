-- §1 known-members cap (≤10) doubles as the OTP-issuance allowlist (§4).
CREATE TABLE IF NOT EXISTS allowlist (
    email       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per OTP request. code_hash, never the raw code, is stored.
CREATE TABLE IF NOT EXISTS otp_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    consumed    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (email) REFERENCES allowlist(email)
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_email ON otp_codes(email);

-- Per-device table (§4). Phase 1 only needs enough of this to mint tokens;
-- revocation/heartbeat/expiry logic lands in Phase 2.
CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,           -- client-generated device id
    email        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
    platform     TEXT NOT NULL CHECK (platform IN ('android','web')),
    last_seen_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (email) REFERENCES allowlist(email)
);
CREATE INDEX IF NOT EXISTS idx_devices_email ON devices(email);
