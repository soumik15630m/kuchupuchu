"""Coverage for the new structured-logging/metrics additions."""
import json
import logging

from app.logging_config import JsonFormatter


def test_metrics_endpoint_exposes_prometheus_text_format(client, fresh_db):
    res = client.get("/metrics")
    assert res.status_code == 200
    assert "text/plain" in res.headers["content-type"]
    assert "http_requests_total" in res.text


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
