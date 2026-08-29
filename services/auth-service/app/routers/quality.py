"""§13 Phase 3 endpoints: quality-report ingest and the read-only dashboard.

Auth posture matches devices.py's router: the same short-lived access
token used everywhere else, not a separate credential. A client that can
mint a room token can also report on the call it's about to join.
"""
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.quality import record_quality_report, recent_quality_reports
from app.session_tokens import verify_token

router = APIRouter()


def _require_access_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = authorization[len("Bearer ") :]
    try:
        payload = verify_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="unauthorized")
    if payload["type"] != "access":
        raise HTTPException(status_code=401, detail="unauthorized")
    return payload["sub"]


class QualityReportIn(BaseModel):
    room_name: str
    device_id: str
    connection_quality: str | None = None
    candidate_type: str | None = Field(default=None, description="host | srflx | relay")
    relay_protocol: str | None = Field(default=None, description="udp | tcp | tls")
    rtt_ms: float | None = None
    jitter_ms: float | None = None
    packet_loss_pct: float | None = None
    data_saver_on: bool = False
    audio_only: bool = False


@router.post("/report")
def report_quality(body: QualityReportIn, authorization: str | None = Header(default=None)):
    _require_access_token(authorization)
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
    _require_access_token(authorization)
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
