"""Unattended administrator bootstrap (production first-boot)."""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import bootstrap
from app.config import settings
from app.models import AppSetting, User
from app.security import verify_password


def _run_bootstrap(monkeypatch, username: str, password: str, name: str = "Admin Boot") -> int:
    monkeypatch.setattr(settings, "bootstrap_admin_username", username)
    monkeypatch.setattr(settings, "bootstrap_admin_password", password)
    monkeypatch.setattr(settings, "bootstrap_admin_name", name)
    return bootstrap.ensure_bootstrap_admin()


def test_bootstrap_creates_admin_and_closes_setup(monkeypatch, db, client: TestClient) -> None:
    code = _run_bootstrap(monkeypatch, "heda", "WedhusGembel5")
    assert code == 0

    admin = db.scalar(select(User).where(User.username == "heda"))
    assert admin is not None
    assert admin.role == "ADMIN"
    assert admin.is_active is True
    # The bootstrap password is the operator's own choice: no forced rotation.
    assert admin.must_change_password is False
    assert verify_password("WedhusGembel5", admin.password_hash)

    setting = db.get(AppSetting, "setup_completed")
    assert setting is not None and setting.value == "true"

    # /setup is now permanently closed.
    status = client.get("/api/v1/setup/status").json()
    assert status["setup_required"] is False


def test_bootstrap_defaults_match_the_documented_credentials(monkeypatch, db) -> None:
    """The shipped defaults are username `heda` / password `WedhusGembel5`."""
    monkeypatch.setattr(settings, "bootstrap_admin_username", "heda")
    monkeypatch.setattr(settings, "bootstrap_admin_password", "WedhusGembel5")
    assert bootstrap.ensure_bootstrap_admin() == 0

    admin = db.scalar(select(User).where(User.username == "heda"))
    assert admin is not None and admin.role == "ADMIN"
    assert verify_password("WedhusGembel5", admin.password_hash)


def test_bootstrap_is_idempotent(monkeypatch, db) -> None:
    assert _run_bootstrap(monkeypatch, "heda", "WedhusGembel5") == 0
    assert _run_bootstrap(monkeypatch, "heda", "WedhusGembel5") == 0

    admins = db.scalars(select(User).where(User.role == "ADMIN")).all()
    assert len(admins) == 1


def test_bootstrap_skips_when_not_configured(monkeypatch, db) -> None:
    monkeypatch.setattr(settings, "bootstrap_admin_username", "")
    monkeypatch.setattr(settings, "bootstrap_admin_password", "")
    assert bootstrap.ensure_bootstrap_admin() == 0
    assert db.scalar(select(User).where(User.role == "ADMIN")) is None


def test_bootstrap_rejects_partial_configuration(monkeypatch, db) -> None:
    monkeypatch.setattr(settings, "bootstrap_admin_username", "heda")
    monkeypatch.setattr(settings, "bootstrap_admin_password", "")
    assert bootstrap.ensure_bootstrap_admin() == 1
    assert db.scalar(select(User).where(User.role == "ADMIN")) is None


def test_bootstrap_ignores_bad_config_once_admin_exists(monkeypatch, db) -> None:
    """Clearing BOOTSTRAP_ADMIN_* after first boot must not crash the API."""
    assert _run_bootstrap(monkeypatch, "heda", "WedhusGembel5") == 0

    # Operator empties the password (as .env.example suggests) — still healthy.
    monkeypatch.setattr(settings, "bootstrap_admin_password", "")
    assert bootstrap.ensure_bootstrap_admin() == 0

    # Even a now-too-weak password is irrelevant: nothing is being created.
    assert _run_bootstrap(monkeypatch, "heda", "short") == 0

    admins = db.scalars(select(User).where(User.role == "ADMIN")).all()
    assert len(admins) == 1


def test_bootstrap_rejects_weak_password(monkeypatch, db) -> None:
    assert _run_bootstrap(monkeypatch, "heda", "short") == 1
    assert db.scalar(select(User).where(User.role == "ADMIN")) is None


def test_bootstrap_promotes_existing_non_admin(monkeypatch, db) -> None:
    proctor = User(
        username="heda",
        full_name="Promoted",
        password_hash=None,
        role="PROCTOR",
        is_active=False,
    )
    db.add(proctor)
    db.commit()

    assert _run_bootstrap(monkeypatch, "heda", "WedhusGembel5") == 0
    db.expire_all()
    promoted = db.scalar(select(User).where(User.username == "heda"))
    assert promoted.role == "ADMIN"
    assert promoted.is_active is True
    assert verify_password("WedhusGembel5", promoted.password_hash)


def test_bootstrapped_admin_can_log_in(monkeypatch, client: TestClient) -> None:
    assert _run_bootstrap(monkeypatch, "heda", "WedhusGembel5") == 0

    response = client.post(
        "/api/v1/auth/login",
        json={"username": "heda", "password": "WedhusGembel5"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["role"] == "ADMIN"
