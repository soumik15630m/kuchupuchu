"""§4/§13 Phase 2 device-table tests, independent of the HTTP layer
(routers/devices.py and routers/auth.py have their own tests). Covers the
gaps the audit flagged as untested: device cap enforcement, revoked-device
rejection, cross-email collision, reactivation, and revoke-all semantics."""
import pytest

from app.db import get_db
from app.devices import (
    DEVICE_CAP_PER_PERSON,
    DeviceLimitReachedError,
    DeviceNotFoundError,
    DeviceRevokedError,
    NotDeviceOwnerError,
    expire_stale_web_devices,
    get_device,
    get_device_version,
    is_device_active,
    list_devices_for_email,
    register_or_touch_device,
    revoke_all_devices,
    revoke_device,
)


@pytest.fixture(autouse=True)
def _allowlisted(fresh_db):
    # devices.email has a FOREIGN KEY on allowlist(email) -- every test
    # here registers a@/b@example.com, so allowlist both up front.
    get_db().executemany(
        "INSERT OR IGNORE INTO allowlist (email) VALUES (?)",
        [("a@example.com",), ("b@example.com",)],
    )
    get_db().commit()


def test_new_device_registers_as_active_and_bumps_version(fresh_db):
    assert get_device_version("a@example.com") == 0
    status = register_or_touch_device("a@example.com", "dev-1", "web")
    assert status == "active"
    assert get_device_version("a@example.com") == 1
    row = get_device("dev-1")
    assert row["status"] == "active"
    assert row["platform"] == "web"


def test_touching_an_already_active_device_does_not_bump_version(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    version_after_first = get_device_version("a@example.com")
    register_or_touch_device("a@example.com", "dev-1", "web")
    assert get_device_version("a@example.com") == version_after_first


def test_device_cap_is_enforced(fresh_db):
    for i in range(DEVICE_CAP_PER_PERSON):
        register_or_touch_device("a@example.com", f"dev-{i}", "web")
    with pytest.raises(DeviceLimitReachedError):
        register_or_touch_device("a@example.com", "dev-overflow", "web")


def test_device_cap_is_scoped_per_email(fresh_db):
    for i in range(DEVICE_CAP_PER_PERSON):
        register_or_touch_device("a@example.com", f"dev-{i}", "web")
    # b@example.com has zero devices of their own -- must not be blocked
    # by a@example.com's count.
    register_or_touch_device("b@example.com", "dev-b1", "web")


def test_revoked_device_cannot_re_register(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    revoke_device("dev-1", "a@example.com")
    with pytest.raises(DeviceRevokedError):
        register_or_touch_device("a@example.com", "dev-1", "web")


def test_device_id_collision_across_emails_is_rejected(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    with pytest.raises(DeviceNotFoundError):
        register_or_touch_device("b@example.com", "dev-1", "web")


def test_reactivating_an_expired_device_bumps_version(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    # Force expiry directly rather than depending on the sweep's time cutoff.
    from app.db import get_db

    get_db().execute("UPDATE devices SET status = 'expired' WHERE id = ?", ("dev-1",))
    get_db().commit()
    version_before = get_device_version("a@example.com")

    register_or_touch_device("a@example.com", "dev-1", "web")

    assert get_device("dev-1")["status"] == "active"
    assert get_device_version("a@example.com") == version_before + 1


def test_reactivating_an_expired_device_does_not_count_against_the_cap(fresh_db):
    for i in range(DEVICE_CAP_PER_PERSON):
        register_or_touch_device("a@example.com", f"dev-{i}", "web")
    from app.db import get_db

    get_db().execute("UPDATE devices SET status = 'expired' WHERE id = ?", ("dev-0",))
    get_db().commit()

    # Cap-worth of active devices is now DEVICE_CAP_PER_PERSON - 1; reactivating
    # the expired one should succeed rather than being blocked as "new".
    register_or_touch_device("a@example.com", "dev-0", "web")
    assert get_device("dev-0")["status"] == "active"


def test_is_device_active_false_for_unknown_device(fresh_db):
    assert is_device_active("no-such-device", "a@example.com") is False


def test_is_device_active_false_for_wrong_email(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    assert is_device_active("dev-1", "b@example.com") is False


def test_revoke_device_requires_ownership(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    with pytest.raises(NotDeviceOwnerError):
        revoke_device("dev-1", "b@example.com")
    assert get_device("dev-1")["status"] == "active"


def test_revoke_unknown_device_raises_not_found(fresh_db):
    with pytest.raises(DeviceNotFoundError):
        revoke_device("no-such-device", "a@example.com")


def test_revoke_device_bumps_version_once(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    version_before = get_device_version("a@example.com")
    revoke_device("dev-1", "a@example.com")
    assert get_device_version("a@example.com") == version_before + 1
    assert get_device("dev-1")["status"] == "revoked"


def test_revoking_an_already_revoked_device_does_not_bump_version_again(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    revoke_device("dev-1", "a@example.com")
    version_after_first_revoke = get_device_version("a@example.com")
    revoke_device("dev-1", "a@example.com")
    assert get_device_version("a@example.com") == version_after_first_revoke


def test_revoke_all_devices_revokes_every_active_device_once(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    register_or_touch_device("a@example.com", "dev-2", "android")
    version_before = get_device_version("a@example.com")

    revoked_ids = revoke_all_devices("a@example.com")

    assert sorted(revoked_ids) == ["dev-1", "dev-2"]
    assert all(row["status"] == "revoked" for row in list_devices_for_email("a@example.com"))
    # One bump for the whole batch, not one per device.
    assert get_device_version("a@example.com") == version_before + 1


def test_revoke_all_devices_is_noop_when_none_are_active(fresh_db):
    assert revoke_all_devices("nobody-registered@example.com") == []


def test_revoke_all_devices_does_not_touch_other_emails(fresh_db):
    register_or_touch_device("a@example.com", "dev-1", "web")
    register_or_touch_device("b@example.com", "dev-2", "web")
    revoke_all_devices("a@example.com")
    assert get_device("dev-2")["status"] == "active"


def test_expire_stale_web_devices_only_touches_stale_web_devices(fresh_db):
    from datetime import datetime, timedelta, timezone

    from app.db import get_db
    from app.devices import WEB_HEARTBEAT_EXPIRY_DAYS

    register_or_touch_device("a@example.com", "web-stale", "web")
    register_or_touch_device("a@example.com", "web-fresh", "web")
    register_or_touch_device("b@example.com", "android-stale", "android")

    stale = (datetime.now(timezone.utc) - timedelta(days=WEB_HEARTBEAT_EXPIRY_DAYS + 1)).isoformat()
    db = get_db()
    db.execute("UPDATE devices SET last_seen_at = ? WHERE id IN ('web-stale', 'android-stale')", (stale,))
    db.commit()

    version_before = get_device_version("a@example.com")
    expired = expire_stale_web_devices()

    assert expired == ["web-stale"]
    assert get_device("web-stale")["status"] == "expired"
    assert get_device("web-fresh")["status"] == "active"
    # Android devices are never auto-expired here regardless of staleness.
    assert get_device("android-stale")["status"] == "active"
    # Routine cleanup, not a trust event -- must not bump the version.
    assert get_device_version("a@example.com") == version_before
