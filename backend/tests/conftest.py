"""Test fixtures: isolated SQLite database + FastAPI TestClient."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

TMP_DIR = Path(tempfile.mkdtemp(prefix="examguard-tests-"))
DB_PATH = TMP_DIR / "test.db"

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{DB_PATH.as_posix()}")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-tests-only")
os.environ.setdefault("SETUP_SECRET", "test-setup-secret")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("AUTO_CREATE_TABLES", "true")
os.environ.setdefault("EXPIRY_SWEEP_SECONDS", "3600")
os.environ.setdefault("LOGIN_RATE_LIMIT_PER_MINUTE", "1000")
os.environ.setdefault("REGISTER_RATE_LIMIT_PER_MINUTE", "1000")
os.environ.setdefault("PARTICIPANT_IDENTITY_MODE", "none")

from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.database import SessionLocal, create_all, engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.fixture(scope="session")
def settings():
    return get_settings()


@pytest.fixture()
def app():
    from app import ratelimit as rl
    from app.api import auth as auth_module
    from app.api import participant as participant_module

    auth_module.login_limiter.reset()
    auth_module.setup_limiter.reset()
    participant_module.register_limiter.reset()
    yield create_app()


@pytest.fixture()
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _csrf(client: TestClient) -> str:
    return client.cookies.get("eg_csrf") or ""


@pytest.fixture()
def admin_client(client: TestClient) -> TestClient:
    """Complete first-run setup and return an authenticated client."""
    response = client.post(
        "/api/v1/setup",
        json={
            "setup_secret": "test-setup-secret",
            "username": "admin",
            "full_name": "Admin Utama",
            "password": "AdminRahasia123",
        },
    )
    assert response.status_code == 201, response.text
    client.headers.update({"X-CSRF-Token": response.json()["csrf_token"]})
    return client


@pytest.fixture()
def csrf_token(admin_client: TestClient) -> str:
    return admin_client.headers.get("X-CSRF-Token", "")
