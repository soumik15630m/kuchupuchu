-- /quality/recent's actual query is `ORDER BY reported_at DESC, id DESC
-- LIMIT ?` with no WHERE room_name -- the existing index (room_name,
-- reported_at) doesn't serve it at all, so every poll does a full-table
-- scan-and-sort. `id` is already a monotonic proxy for insertion order,
-- so an index on it alone lets SQLite satisfy the ORDER BY/LIMIT with a
-- straight index scan.
CREATE INDEX IF NOT EXISTS idx_quality_reports_id_desc ON quality_reports(id DESC);
