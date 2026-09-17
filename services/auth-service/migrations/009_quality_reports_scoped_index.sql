-- Two corrections to 007's index, both caused by the same thing: the
-- query it was written for has changed, and the index never matched what
-- SQLite actually needed anyway.
--
-- 1. idx_quality_reports_id_desc was redundant from the start. `id` is
--    INTEGER PRIMARY KEY AUTOINCREMENT, which in SQLite is an alias for
--    the rowid -- the table IS that index, and SQLite can already walk it
--    backwards for `ORDER BY id DESC`. The separate index only added
--    write cost on every inserted snapshot.
--
-- 2. /quality/recent is no longer unscoped: it now filters to the
--    caller's own devices (see app/quality.py's recent_quality_reports --
--    it used to hand every member's room names and device ids to any
--    active device). That filter is the selective part of the query, so
--    the useful index is on device_id with id as the tiebreaker, letting
--    SQLite satisfy both the WHERE and the ORDER BY from one index.
DROP INDEX IF EXISTS idx_quality_reports_id_desc;

CREATE INDEX IF NOT EXISTS idx_quality_reports_device_id
    ON quality_reports(device_id, id DESC);
