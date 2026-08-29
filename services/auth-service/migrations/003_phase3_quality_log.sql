-- Phase 3 (§13): call quality & Russia-path reliability.
--
-- Stores periodic connection-quality snapshots reported by a connected
-- client (see testing/webrtc-harness/app.js for the reporter used until
-- Phase 5's real clients exist). This is what the "quality dashboard/logs
-- show which candidate type won each call" done-bar criterion reads from.

CREATE TABLE IF NOT EXISTS quality_reports (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    room_name        TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    reported_at      TEXT NOT NULL DEFAULT (datetime('now')),
    connection_quality TEXT,      -- LiveKit's own enum: excellent/good/poor
    candidate_type   TEXT,        -- host / srflx / relay
    relay_protocol   TEXT,        -- udp / tcp / tls (only set when candidate_type = relay)
    rtt_ms           REAL,
    jitter_ms        REAL,
    packet_loss_pct  REAL,
    data_saver_on    INTEGER NOT NULL DEFAULT 0,
    audio_only       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_quality_reports_room_time
    ON quality_reports(room_name, reported_at);
