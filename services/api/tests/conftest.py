import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "packages" / "contracts"))
sys.path.insert(0, str(REPOSITORY_ROOT / "services" / "api"))


import pytest


@pytest.fixture(autouse=True)
def _never_send_real_email(monkeypatch):
    """Tests must never reach Resend, even when a developer's shell exports its key."""
    monkeypatch.delenv("RESEND_API_KEY", raising=False)


@pytest.fixture(autouse=True)
def _no_background_balance_checks(monkeypatch):
    """The periodic provider-balance check calls provider APIs; it is always off in tests."""
    monkeypatch.setenv("PROVIDER_BALANCE_CHECK_HOURS", "0")
