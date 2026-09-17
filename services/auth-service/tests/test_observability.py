"""Coverage for the new structured-logging/metrics additions."""
import json
import logging

from app.logging_config import JsonFormatter


def _admin_token(db, email: str = "admin@example.com", device_id: str = "dev-admin") -> str:
    from tests.conftest import access_token_for, register_device

    register_device(db, email, device_id)
    db.execute("UPDATE allowlist SET is_admin = 1 WHERE email = ?", (email,))
    db.commit()
    return access_token_for(email, device_id)


def test_metrics_endpoint_exposes_prometheus_text_format(client, fresh_db):
    token = _admin_token(fresh_db)
    res = client.get("/metrics", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert "text/plain" in res.headers["content-type"]
    assert "http_requests_total" in res.text


def test_metrics_endpoint_is_not_readable_without_admin(client, fresh_db):
    """nginx proxies /auth/ to this app's root, so an unauthenticated
    /metrics was publicly reachable at https://<host>/auth/metrics --
    publishing OTP outcome counts (including not-allowlisted rejections),
    revocation counts, and per-route traffic to anyone who asked.

    404, not 403, for a non-admin: confirming the endpoint exists is its
    own small leak, matching routers/devices.py's admin routes.
    """
    from tests.conftest import access_token_for, register_device

    assert client.get("/metrics").status_code == 401

    register_device(fresh_db, "plain@example.com", "dev-plain")
    token = access_token_for("plain@example.com", "dev-plain")
    assert client.get("/metrics", headers={"Authorization": f"Bearer {token}"}).status_code == 404


def test_metrics_count_requests_by_route_template_not_raw_path(client, fresh_db):
    from app.devices import register_or_touch_device

    fresh_db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES ('a@example.com')")
    fresh_db.commit()
    register_or_touch_device("a@example.com", "dev-1", "web")

    client.get("/devices/no-such-device-id-but-any-would-do")  # 404, still labeled by template
    res = client.get("/metrics")
    # Labeled with the route template (e.g. .../devices/me), never the raw
    # per-request path -- otherwise every distinct device id/room name
    # becomes its own time series.
    assert 'path="/no-such-device-id-but-any-would-do"' not in res.text


def test_json_formatter_produces_one_parseable_object_per_record():
    record = logging.LogRecord(
        name="app.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="hello %s", args=("world",), exc_info=None,
    )
    line = JsonFormatter().format(record)
    parsed = json.loads(line)
    assert parsed["message"] == "hello world"
    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "app.test"
    assert "timestamp" in parsed


def test_json_formatter_includes_extra_fields():
    record = logging.LogRecord(
        name="app.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="revoked device", args=(), exc_info=None,
    )
    record.device_id = "dev-123"
    parsed = json.loads(JsonFormatter().format(record))
    assert parsed["device_id"] == "dev-123"


def test_rate_limiter_does_not_retain_keys_forever():
    """The OTP limiter is keyed by source IP. Without eviction an attacker
    walking addresses turns a memory-bounded defence into unbounded
    allocation -- the limiter becomes the DoS it exists to prevent."""
    import time

    from app.rate_limit import _SWEEP_THRESHOLD, SlidingWindowLimiter

    limiter = SlidingWindowLimiter(max_events=5, window_seconds=0.01, name="test")
    for i in range(_SWEEP_THRESHOLD + 200):
        limiter.check(f"ip-{i}")
    time.sleep(0.05)
    limiter.check("ip-final")

    assert len(limiter._events) < _SWEEP_THRESHOLD


def test_rate_limiter_sweep_does_not_forget_a_live_window():
    """Eviction must only drop keys whose window has fully expired -- a
    sweep that also cleared active ones would silently reset the limit."""
    from app.rate_limit import _SWEEP_THRESHOLD, SlidingWindowLimiter

    limiter = SlidingWindowLimiter(max_events=2, window_seconds=60, name="test")
    assert limiter.check("live") is True
    assert limiter.check("live") is True
    for i in range(_SWEEP_THRESHOLD + 10):
        limiter.check(f"other-{i}")
    assert limiter.check("live") is False, "an in-window key must survive the sweep"


def test_db_connections_are_per_thread_and_reset_across_threads(tmp_path, monkeypatch):
    """reset_connections() must invalidate connections owned by OTHER
    threads. A registry-based 'close them all from here' cannot: sqlite3's
    check_same_thread guard applies to close() too, so it raises
    ProgrammingError for every connection the caller doesn't own -- and a
    broad `except sqlite3.Error` around that makes the whole thing a
    silent no-op."""
    import threading

    import app.db as db_module

    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "a.db"))
    db_module.reset_connections()

    seen = {}

    def worker(stage_one, stage_two):
        conn = db_module.get_db()
        conn.execute("CREATE TABLE IF NOT EXISTS marker (x)")
        seen["first"] = id(conn)
        stage_one.set()
        stage_two.wait(timeout=5)
        refreshed = db_module.get_db()
        seen["second"] = id(refreshed)
        # Must be usable, i.e. not a closed handle to the old file.
        refreshed.execute("SELECT 1")
        seen["usable"] = True

    one, two = threading.Event(), threading.Event()
    thread = threading.Thread(target=worker, args=(one, two))
    thread.start()
    assert one.wait(timeout=5)

    # Main thread, different connection object entirely.
    assert id(db_module.get_db()) != seen["first"]

    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "b.db"))
    db_module.reset_connections()
    two.set()
    thread.join(timeout=5)

    assert seen["usable"] is True
    assert seen["second"] != seen["first"], "the worker kept a stale connection across a reset"

    db_module.reset_connections()


def test_json_formatter_redacts_secret_shaped_extra_fields():
    """`extra=` fields are written verbatim into whatever collects logs.
    Redaction by key name is a backstop -- the real rule is not to log
    these -- but the cost of being wrong is a durable, replicated copy."""
    from app.logging_config import REDACTED

    record = logging.LogRecord(
        name="app.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="something happened", args=(), exc_info=None,
    )
    record.device_id = "dev-123"
    record.refresh_token = "super-secret-value"
    record.api_key = "ak_live_123"
    record.code_hash = "deadbeef"

    parsed = json.loads(JsonFormatter().format(record))
    assert parsed["device_id"] == "dev-123", "non-sensitive fields must still come through"
    for key in ("refresh_token", "api_key", "code_hash"):
        assert parsed[key] == REDACTED
        assert "super-secret-value" not in json.dumps(parsed)


def test_otp_transport_must_be_chosen_explicitly(monkeypatch):
    """Defaulting to 'console' is fail-open for the most sensitive value
    in the system: a deployment that forgot OTP_TRANSPORT=smtp would send
    no email and print every login code to stdout, where anyone with log
    access could authenticate as any member -- while looking healthy."""
    import pytest

    from app.mailer import validate_transport

    monkeypatch.delenv("OTP_TRANSPORT", raising=False)
    with pytest.raises(RuntimeError, match="must be explicitly set"):
        validate_transport()

    monkeypatch.setenv("OTP_TRANSPORT", "carrier-pigeon")
    with pytest.raises(RuntimeError, match="must be explicitly set"):
        validate_transport()

    monkeypatch.setenv("OTP_TRANSPORT", "console")
    validate_transport()  # allowed, but warns


def test_smtp_transport_requires_its_settings(monkeypatch):
    import pytest

    from app.mailer import validate_transport

    monkeypatch.setenv("OTP_TRANSPORT", "smtp")
    for key in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError, match="SMTP_HOST"):
        validate_transport()


def test_migration_failure_does_not_leave_itself_recorded(tmp_path, monkeypatch):
    """executescript() commits before running, so the schema change and
    the row recording it cannot share a transaction. A crash between them
    would replay a non-idempotent migration on the next boot."""
    import pytest

    import app.db as db_module
    import app.migrate as migrate_module

    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "broken.db"))
    db_module.reset_connections()

    bad_dir = tmp_path / "migrations"
    bad_dir.mkdir()
    (bad_dir / "001_ok.sql").write_text("CREATE TABLE IF NOT EXISTS fine (x);")
    (bad_dir / "002_broken.sql").write_text("THIS IS NOT VALID SQL;")
    monkeypatch.setattr(migrate_module, "MIGRATIONS_DIR", bad_dir)

    with pytest.raises(Exception):
        migrate_module.run_migrations()

    recorded = {
        row["filename"]
        for row in db_module.get_db().execute("SELECT filename FROM _migrations")
    }
    assert "001_ok.sql" in recorded
    assert "002_broken.sql" not in recorded, "a failed migration must not be recorded as applied"

    db_module.reset_connections()


def test_migration_prefix_collision_is_rejected(tmp_path, monkeypatch):
    """Apply order between two files sharing a prefix is decided by the
    rest of the filename -- which is not where anyone looks."""
    import pytest

    import app.db as db_module
    import app.migrate as migrate_module

    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "dup.db"))
    db_module.reset_connections()

    dup_dir = tmp_path / "migrations"
    dup_dir.mkdir()
    (dup_dir / "001_a.sql").write_text("CREATE TABLE IF NOT EXISTS a (x);")
    (dup_dir / "001_b.sql").write_text("CREATE TABLE IF NOT EXISTS b (x);")
    monkeypatch.setattr(migrate_module, "MIGRATIONS_DIR", dup_dir)

    with pytest.raises(RuntimeError, match="share the prefix"):
        migrate_module.run_migrations()

    db_module.reset_connections()
