"""Prometheus metrics (exposed at GET /metrics, scraped -- not pushed).

Kept as one module of plain module-level metric objects, imported wherever
something needs incrementing, rather than threading a metrics client
through every function signature.
"""
from prometheus_client import Counter, Histogram

http_requests_total = Counter(
    "http_requests_total",
    "HTTP requests handled",
    ["method", "path", "status"],
)

http_request_duration_seconds = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency",
    ["method", "path"],
)

otp_requests_total = Counter(
    "otp_requests_total",
    "OTP requests, by outcome",
    ["outcome"],  # sent | not_allowlisted | rate_limited
)

otp_verifications_total = Counter(
    "otp_verifications_total",
    "OTP verification attempts, by outcome",
    ["outcome"],  # success | invalid | expired | too_many_attempts
)

device_revocations_total = Counter(
    "device_revocations_total",
    "Devices revoked, by trigger",
    ["trigger"],  # self_service | admin | refresh_reuse
)
