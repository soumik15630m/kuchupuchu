import json
import os
import stat

import pytest

from app.auth import ensure_vapid_keypair, vapid_key_path
from app.vapid import load_private_key


@pytest.fixture
def keyless(tmp_path, monkeypatch):
    """No pair in the environment, and a fresh path to write one to."""
    monkeypatch.delenv("WAKE_VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("WAKE_VAPID_PUBLIC_KEY", raising=False)
    monkeypatch.setenv("WAKE_VAPID_KEY_PATH", str(tmp_path / "vapid.json"))
    return tmp_path / "vapid.json"


class TestGeneration:
    def test_a_pair_is_generated_when_there_is_none(self, keyless):
        private, public = ensure_vapid_keypair()
        assert private and public
        # Usable, not merely present.
        load_private_key(private)
        assert keyless.is_file()

    def test_the_same_pair_comes_back_on_the_next_boot(self, keyless):
        """The one that matters. A browser refuses a push signed by a key it
        did not subscribe with, so regenerating on restart would silently
        unsubscribe every member and look exactly like nothing happening."""
        first = ensure_vapid_keypair()
        second = ensure_vapid_keypair()
        assert first == second

    def test_what_was_written_is_what_is_read_back(self, keyless):
        private, public = ensure_vapid_keypair()
        stored = json.loads(keyless.read_text(encoding="utf-8"))
        assert stored == {"private": private, "public": public}

    @pytest.mark.skipif(
        os.name != "posix",
        reason="Windows ignores the POSIX mode os.open is given, so there is "
        "nothing to assert here; the deployment target is a Linux container",
    )
    def test_the_private_key_is_not_world_readable(self, keyless):
        ensure_vapid_keypair()
        assert stat.S_IMODE(os.stat(keyless).st_mode) == 0o600

    def test_the_directory_is_created_if_it_is_missing(self, tmp_path, monkeypatch):
        monkeypatch.delenv("WAKE_VAPID_PRIVATE_KEY", raising=False)
        monkeypatch.delenv("WAKE_VAPID_PUBLIC_KEY", raising=False)
        nested = tmp_path / "data" / "nested" / "vapid.json"
        monkeypatch.setenv("WAKE_VAPID_KEY_PATH", str(nested))
        ensure_vapid_keypair()
        assert nested.is_file()


class TestEnvironmentWins:
    def test_an_explicit_pair_is_used_as_is(self, keyless, monkeypatch):
        monkeypatch.setenv("WAKE_VAPID_PRIVATE_KEY", "from-the-environment")
        monkeypatch.setenv("WAKE_VAPID_PUBLIC_KEY", "public-from-the-environment")
        assert ensure_vapid_keypair() == ("from-the-environment", "public-from-the-environment")
        # Nothing is written: an operator carrying keys between machines must
        # not end up with a second pair on disk that silently takes over.
        assert not keyless.exists()

    def test_half_a_pair_in_the_environment_is_ignored(self, keyless, monkeypatch):
        # Half a pair cannot sign anything; falling back to a generated pair
        # beats starting with one key and no matching other.
        monkeypatch.setenv("WAKE_VAPID_PRIVATE_KEY", "only-the-private-half")
        private, _ = ensure_vapid_keypair()
        assert private != "only-the-private-half"
        assert keyless.is_file()

    def test_the_path_is_configurable(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WAKE_VAPID_KEY_PATH", str(tmp_path / "elsewhere.json"))
        assert vapid_key_path() == tmp_path / "elsewhere.json"
