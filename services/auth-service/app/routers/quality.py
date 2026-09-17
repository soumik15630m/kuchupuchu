"""§13 Phase 3 endpoints: quality-report ingest and the read-only dashboard.

Auth: uses `require_active_device` (app/auth_deps.py), the same strict
check room.py uses -- a revoked device can't post or read quality data
just because its old access token hasn't expired yet. This intentionally
does NOT reuse devices.py's lighter check; quality data isn't the "explain
why you're locked out" screen that exception exists for.
"""
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.auth_deps import require_active_device
from app.devices import is_admin_email
from app.quality import record_quality_report, recent_quality_reports
from app.rate_limit import SlidingWindowLimiter, register, reset_all

router = APIRouter()

# Basic per-device rate limit: the harness reports every 5s (see
# testing/webrtc-harness/app.js's QUALITY_REPORT_INTERVAL_MS), so allowing
# a handful per window comfortably covers normal use plus retries while
# still bounding a buggy or malicious client's ability to flood SQLite.
_report_limiter = register(
    SlidingWindowLimiter(max_events=5, window_seconds=10, name="quality_report")
)


def _reset_rate_limiter_state() -> None:
    """Test-only hook, kept under its original name because
    tests/conftest.py calls it. Resets every registered limiter, not just
    this module's -- process-global limiter state leaks across test cases
    wherever it lives."""
    reset_all()


def _check_rate_limit(device_id: str) -> None:
    if not _report_limiter.check(device_id):
        raise HTTPException(status_code=429, detail="too many quality reports, slow down")


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
    """Your own devices' reports. Admins (§4, routers/devices.py) get the
    whole picture, since diagnosing "is the Russia path working" is
    exactly the cross-member question the dashboard exists to answer and
    admin is already the privilege level for cross-person operations."""
    email, _ = require_active_device(authorization)
    scope = None if is_admin_email(email) else email
    return {"reports": recent_quality_reports(email=scope)}


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
    const cell = (text, className) => {
      const td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = text ?? '';
      return td;
    };
    row.append(
      cell(r.reported_at),
      cell(r.room_name),
      cell(r.device_id),
      cell(r.connection_quality, qClass),
      cell(r.candidate_type, r.candidate_type === 'relay' ? 'relay' : ''),
      cell(r.relay_protocol),
      cell(r.rtt_ms),
      cell(r.jitter_ms),
      cell(r.packet_loss_pct),
      cell(r.data_saver_on ? 'on' : ''),
      cell(r.audio_only ? 'on' : ''),
    );
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
