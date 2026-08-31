"""§13 Phase 3: app/quality.py storage-layer tests, independent of the
HTTP layer (routers/quality.py has its own tests in test_quality.py)."""
from app.quality import record_quality_report, recent_quality_reports


def test_record_and_fetch_round_trip(fresh_db):
    record_quality_report(
        room_name="room-a",
        device_id="dev-1",
        connection_quality="excellent",
        candidate_type="host",
        relay_protocol=None,
        rtt_ms=30.0,
        jitter_ms=2.0,
        packet_loss_pct=0.0,
        data_saver_on=False,
        audio_only=False,
    )
    reports = recent_quality_reports()
    assert len(reports) == 1
    assert reports[0]["room_name"] == "room-a"
    assert reports[0]["candidate_type"] == "host"
    assert reports[0]["data_saver_on"] == 0  # stored as SQLite 0/1, not a bool
    assert reports[0]["audio_only"] == 0


def test_recent_reports_respects_limit_and_ordering(fresh_db):
    for i in range(5):
        record_quality_report(
            room_name=f"room-{i}",
            device_id="dev-1",
            connection_quality="good",
            candidate_type=None,
            relay_protocol=None,
            rtt_ms=None,
            jitter_ms=None,
            packet_loss_pct=None,
            data_saver_on=False,
            audio_only=False,
        )
    reports = recent_quality_reports(limit=3)
    assert len(reports) == 3
    # Most recent first.
    assert reports[0]["room_name"] == "room-4"
