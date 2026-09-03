-- Cross-person admin revoke (§4 "revoke a person" as an admin action).
-- Deliberately a flag on the existing allowlist table rather than a new
-- roles/permissions table -- at the §1 cap of <=10 known members, a
-- second table for what's really a single boolean is over-engineering.
ALTER TABLE allowlist ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
