-- Usernames and profiles.
--
-- `email` remains the stable internal account identifier: it is the allowlist
-- primary key and is referenced by devices, prekeys and quality reports, and
-- the messaging service addresses envelopes by it. `username` is a mutable
-- public handle that resolves to an account. Keeping the two separate is what
-- lets someone rename themselves without orphaning their devices or keys.
ALTER TABLE allowlist ADD COLUMN username TEXT;

-- The form uniqueness is enforced on: NFKC-normalised and casefolded, so
-- "Alice" and "alice" cannot both exist. `username` keeps the display casing.
ALTER TABLE allowlist ADD COLUMN username_normalized TEXT;

ALTER TABLE allowlist ADD COLUMN display_name TEXT;
ALTER TABLE allowlist ADD COLUMN about TEXT;
ALTER TABLE allowlist ADD COLUMN profile_updated_at TEXT;

-- Partial index: several members may have no username yet, and NULLs must not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_allowlist_username
    ON allowlist (username_normalized)
    WHERE username_normalized IS NOT NULL;

-- Released handles are parked rather than freed immediately. Without this,
-- someone who drops a username can have it taken by another member and be
-- impersonated by anyone still addressing the old handle.
CREATE TABLE IF NOT EXISTS username_history (
    username_normalized TEXT NOT NULL,
    email               TEXT NOT NULL,
    released_at         TEXT NOT NULL,
    PRIMARY KEY (username_normalized, released_at),
    FOREIGN KEY (email) REFERENCES allowlist(email)
);

CREATE INDEX IF NOT EXISTS idx_username_history_released
    ON username_history (username_normalized, released_at);
