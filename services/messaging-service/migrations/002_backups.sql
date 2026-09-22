-- Passphrase-encrypted history backups.
--
-- The blob is AES-256-GCM ciphertext under a key derived on the member's
-- device from a passphrase this service never receives. Everything readable
-- here is metadata the server needs to serve the file back: whose it is, how
-- big, and when it was made. One row per member -- a new backup replaces the
-- old one, because keeping generations of an opaque blob would grow without
-- bound and buy nothing we could reason about.
CREATE TABLE IF NOT EXISTS backups (
    email        TEXT PRIMARY KEY,
    byte_size    INTEGER NOT NULL,
    -- Recorded so a restore can warn when the file predates the device doing
    -- the restoring; the server cannot tell what is inside it.
    created_at   TEXT NOT NULL,
    device_id    TEXT NOT NULL
);
