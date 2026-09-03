"""CORS is configured once at import time from WEB_CLIENT_ORIGIN
(conftest.py sets it before app.main is ever imported) -- these tests
confirm the policy actually restricts to that one origin rather than
reflecting whatever Origin header shows up."""


def test_allowed_origin_gets_cors_header(client):
    res = client.get("/healthz", headers={"Origin": "https://app.test.invalid"})
    assert res.headers.get("access-control-allow-origin") == "https://app.test.invalid"


def test_disallowed_origin_gets_no_cors_header(client):
    res = client.get("/healthz", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in res.headers


def test_preflight_for_allowed_origin_permits_authorization_header(client):
    res = client.options(
        "/devices/me",
        headers={
            "Origin": "https://app.test.invalid",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "https://app.test.invalid"


def test_credentialed_requests_are_not_allowed(client):
    """Tokens travel in the Authorization header, never cookies -- CORS
    credentials mode has nothing to protect here and shouldn't be on."""
    res = client.get("/healthz", headers={"Origin": "https://app.test.invalid"})
    assert res.headers.get("access-control-allow-credentials") != "true"
