-- §10.4/§10.5: store-and-forward for encrypted messages.
--
-- The server stores ciphertext and routing metadata only. `envelope` is an
-- opaque blob produced by the sender's Double Ratchet; this service has no
-- key material and cannot read it.
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    -- Client-chosen id for the logical message, shared across the per-device
    -- copies, so a sender can correlate receipts from a person's two devices
    -- back to one bubble in the UI.
    client_msg_id   TEXT NOT NULL,
    from_email      TEXT NOT NULL,
    from_device     TEXT NOT NULL,
    to_email        TEXT NOT NULL,
    to_device       TEXT NOT NULL,
    -- "text" | "media" | "voice" -- a UI hint. The actual content type is
    -- inside the ciphertext.
    kind            TEXT NOT NULL DEFAULT 'text',
    envelope        TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT,
    read_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox
    ON messages (to_device, delivered_at);

CREATE INDEX IF NOT EXISTS idx_messages_sender_receipts
    ON messages (from_device, client_msg_id);

CREATE INDEX IF NOT EXISTS idx_messages_created
    ON messages (created_at);

-- §10.4: encrypted blobs for images, video and voice notes. Stored
-- client-encrypted; the per-file key is wrapped in the message envelope, so
-- this table never holds anything readable either.
CREATE TABLE IF NOT EXISTS media (
    id              TEXT PRIMARY KEY,
    owner_email     TEXT NOT NULL,
    owner_device    TEXT NOT NULL,
    -- Who is allowed to download it, comma-separated. The recipient set is
    -- fixed at upload so a leaked id is not enough to fetch the blob.
    audience        TEXT NOT NULL,
    byte_size       INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    downloaded_by   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_media_expiry ON media (expires_at);
