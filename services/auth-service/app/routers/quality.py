"""§13 Phase 3 endpoints: quality-report ingest and the read-only dashboard.

Auth: uses `require_active_device` (app/auth_deps.py), the same strict
check room.py uses -- a revoked device can't post or read quality data
just because its old access token hasn't expired yet. This intentionally
does NOT reuse devices.py's lighter check; quality data isn't the "explain
why you're locked out" screen that exception exists for.
"""
import time
from collections import defaultdict, deque
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.auth_deps import require_active_device
from app.quality import record_quality_report, recent_quality_reports

router = APIRouter()

# Basic per-device rate limit: the harness reports every 5s (see
# testing/webrtc-harness/app.js's QUALITY_REPORT_INTERVAL_MS), so allowing
# a handful per window comfortably covers normal use plus retries while
# still bounding a buggy or malicious client's ability to flood SQLite.
# In-memory and per-process is fine at this scale (§1's <=10-member cap,
# single auth-service instance) -- would need a shared store (Redis, which
# is already in the stack for LiveKit) if this ever runs multi-process.
_RATE_LIMIT_WINDOW_SECONDS = 10
_RATE_LIMIT_MAX_REPORTS = 5
_report_timestamps: dict[str, deque] = defaultdict(deque)


def _reset_rate_limiter_state() -> None:
    """Test-only hook -- the limiter is deliberately process-global state
    (see module docstring on why in-memory is fine at this scale), which
    means it leaks across test cases unless something resets it. Called
    from tests/conftest.py's fresh_db fixture, not from any request path.
    """
    _report_timestamps.clear()


def _check_rate_limit(device_id: str) -> None:
    now = time.monotonic()
    timestamps = _report_timestamps[device_id]
    while timestamps and now - timestamps[0] > _RATE_LIMIT_WINDOW_SECONDS:
        timestamps.popleft()
    if len(timestamps) >= _RATE_LIMIT_MAX_REPORTS:
        raise HTTPException(status_code=429, detail="too many quality reports, slow down")
    timestamps.append(now)


class QualityReportIn(BaseModel):
    # Bounded, not arbitrary strings -- matches RoomTokenBody's pattern in
    # room.py (max_length=128) and keeps a buggy client from writing
    # unbounded rows into SQLite.
    room_name: str = Field(min_length=1, max_length=128)
    device_id: str = Field(min_length=1, max_length=128)
    connection_quality: Literal["excellent", "good", "poor"] | None = None
    candidate_type: Literal["host", "srflx", "prflx", "relay"] | None = None
    relay_protocol: Literal["udp", "tcp", "tls"] | None = None
    # Sane physical bounds rather than unbounded floats -- a call's RTT
    # isn't going to be negative or measured in hours.
    rtt_ms: float | None = Field(default=None, ge=0, le=60_000)
    jitter_ms: float | None = Field(default=None, ge=0, le=60_000)
    packet_loss_pct: float | None = Field(default=None, ge=0, le=100)
    data_saver_on: bool = False
    audio_only: bool = False


@router.post("/report")
def report_quality(body: QualityReportIn, authorization: str | None = Header(default=None)):
    email, token_device_id = require_active_device(authorization)
    # The reported device_id must be the caller's own -- otherwise any
    # active device could write quality rows attributed to someone else's
    # device_id. Same ownership posture as devices.py's revoke endpoints.
    if body.device_id != token_device_id:
        raise HTTPException(status_code=403, detail="device_id must match the authenticated device")

    _check_rate_limit(token_device_id)

    record_quality_report(
        room_name=body.room_name,
        device_id=body.device_id,
        connection_quality=body.connection_quality,
        candidate_type=body.candidate_type,
        relay_protocol=body.relay_protocol,
        rtt_ms=body.rtt_ms,
        jitter_ms=body.jitter_ms,
        packet_loss_pct=body.packet_loss_pct,
        data_saver_on=body.data_saver_on,
        audio_only=body.audio_only,
    )
    return {"status": "recorded"}


@router.get("/recent")
def get_recent(authorization: str | None = Header(default=None)):
    require_active_device(authorization)
    return {"reports": recent_quality_reports()}


_DASHBOARD_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Call quality dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #0b0d12; color: #e6e8ee; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #262a35; }
  th { color: #9aa4b2; font-weight: 500; }
  .poor { color: #ff6b6b; }
  .good { color: #ffd166; }
  .excellent { color: #4ade80; }
  .relay { color: #f0a; }
  #tok { width: 100%; margin-bottom: 1rem; font-family: monospace; }
</style>
</head>
<body>
<h1>Call quality — recent reports (§13 Phase 3)</h1>
<input id="tok" placeholder="Bearer access token" />
<table id="tbl"><thead>
  <tr><th>Time</th><th>Room</th><th>Device</th><th>Quality</th>
      <th>Candidate</th><th>Relay proto</th><th>RTT (ms)</th>
      <th>Jitter (ms)</th><th>Loss %</th><th>Data saver</th><th>Audio only</th></tr>
</thead><tbody></tbody></table>
<script>
async function load() {
  const tok = document.getElementById('tok').value.trim();
  if (!tok) return;
  const res = await fetch('/auth/quality/recent', { headers: { Authorization: 'Bearer ' + tok } });
  if (!res.ok) { alert('fetch failed: ' + res.status); return; }
  const { reports } = await res.json();
  const body = document.querySelector('#tbl tbody');
  body.innerHTML = '';
  for (const r of reports) {
    const qClass = (r.connection_quality || '').toLowerCase();
    const row = document.createElement('tr');
    row.innerHTML = `<td>${r.reported_at}</td><td>${r.room_name}</td><td>${r.device_id}</td>
      <td class="${qClass}">${r.connection_quality ?? ''}</td>
      <td class="${r.candidate_type === 'relay' ? 'relay' : ''}">${r.candidate_type ?? ''}</td>
      <td>${r.relay_protocol ?? ''}</td><td>${r.rtt_ms ?? ''}</td>
      <td>${r.jitter_ms ?? ''}</td><td>${r.packet_loss_pct ?? ''}</td>
      <td>${r.data_saver_on ? 'on' : ''}</td><td>${r.audio_only ? 'on' : ''}</td>`;
    body.appendChild(row);
  }
}
document.getElementById('tok').addEventListener('change', load);
setInterval(load, 5000);
</script>
</body>
</html>
"""


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard():
    # No auth on the shell page itself (it's just static markup) -- the
    # token is entered client-side and used only for the /recent fetch,
    # matching the pattern of everything else in this router.
    return _DASHBOARD_HTML
