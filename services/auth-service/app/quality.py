"""Connection-quality report storage (§13 Phase 3).

Deliberately dumb storage -- one row per snapshot, no aggregation here.
Aggregation/graphing happens client-side in the dashboard page, since the
volume (a handful of participants, snapshots every few seconds during
test calls) never justifies pre-aggregating in SQLite.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.db import get_db

# Mirrors devices.py's WEB_HEARTBEAT_EXPIRY_DAYS sweep pattern -- this table
# has no other retention mechanism and grows on every snapshot forever
# otherwise (§13 addendum L10).
RETENTION_DAYS = 30


def record_quality_report(
    room_name: str,
    device_id: str,
    connection_quality: str | None,
    candidate_type: str | None,
    relay_protocol: str | None,
    rtt_ms: float | None,
    jitter_ms: float | None,
    packet_loss_pct: float | None,
    data_saver_on: bool,
    audio_only: bool,
) -> None:
    db = get_db()
    db.execute(
        """
        INSERT INTO quality_reports (
            room_name, device_id, connection_quality, candidate_type,
            relay_protocol, rtt_ms, jitter_ms, packet_loss_pct,
            data_saver_on, audio_only
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            room_name,
            device_id,
            connection_quality,
            candidate_type,
            relay_protocol,
            rtt_ms,
            jitter_ms,
            packet_loss_pct,
            1 if data_saver_on else 0,
            1 if audio_only else 0,
        ),
    )
    db.commit()


def recent_quality_reports(limit: int = 200) -> list[dict]:
    db = get_db()
    rows = db.execute(
        """
        SELECT room_name, device_id, reported_at, connection_quality,
               candidate_type, relay_protocol, rtt_ms, jitter_ms,
               packet_loss_pct, data_saver_on, audio_only
        FROM quality_reports
        ORDER BY reported_at DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def prune_old_quality_reports() -> int:
    """Deletes rows older than RETENTION_DAYS. Returns the number removed,
    for logging. Run on a timer from main.py, same pattern as devices.py's
    expire_stale_web_devices."""
    db = get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).isoformat()
    cur = db.execute("DELETE FROM quality_reports WHERE reported_at < ?", (cutoff,))
    db.commit()
    return cur.rowcount
