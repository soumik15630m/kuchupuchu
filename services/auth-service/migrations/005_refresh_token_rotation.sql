-- Refresh token rotation (§4). Previously "rotation" only issued a new
-- refresh token on use without invalidating the old one -- the old token
-- stayed valid for the rest of its 30-day life. This column holds the jti
-- of the one refresh token currently considered valid per device; a token
-- presented with a stale jti means the current one was already rotated
-- away from, which is the standard signal for "this token was exfiltrated
-- and used out of order" and is treated as a compromise event.

ALTER TABLE devices ADD COLUMN refresh_jti TEXT;
