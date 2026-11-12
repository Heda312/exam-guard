"""Reproduce: bootstrap -> login -> logout -> login with the same credentials.

If this passes, the password hash is stable across logout/login and the
"unauthorized" seen in production comes from the environment (stale
BOOTSTRAP_ADMIN_PASSWORD vs a password changed in the UI, a different database,
or a typo), not from the code.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

os.environ["APP_ENV"] = "test"
_tmp = Path(tempfile.mkdtemp(prefix="login-repro-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_tmp / 'repro.db').as_posix()}"
os.environ["SECRET_KEY"] = "repro-secret"
os.environ["SETUP_SECRET"] = "repro-setup"
os.environ["COOKIE_SECURE"] = "false"
os.environ["AUTO_CREATE_TABLES"] = "true"
os.environ["PARTICIPANT_IDENTITY_MODE"] = "none"

from fastapi.testclient import TestClient  # noqa: E402

from app.bootstrap import ensure_bootstrap_admin  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import User  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from sqlalchemy import select  # noqa: E402

USER = "heda"
PASS = "WedhusGembel5"

settings.bootstrap_admin_username = USER
settings.bootstrap_admin_password = PASS

app = create_app()


def _run_repro(client) -> None:
    # Entering the client context runs the app lifespan, which creates the
    # tables (AUTO_CREATE_TABLES=true) before bootstrap looks at them.
    print("== 1. bootstrap ==")
    assert ensure_bootstrap_admin() == 0
    db = SessionLocal()
    u = db.scalar(select(User).where(User.username == USER))
    print(f"   stored hash: {(u.password_hash or '')[:40]}...")
    db.close()

    print("== 2. login #1 ==")
    r = client.post("/api/v1/auth/login", json={"username": USER, "password": PASS})
    print(f"   status={r.status_code}")
    assert r.status_code == 200, r.text

    print("== 3. logout ==")
    r = client.post("/api/v1/auth/logout")
    print(f"   status={r.status_code}")
    assert r.status_code == 200, r.text

    print("== 4. login #2 (same credentials) ==")
    r = client.post("/api/v1/auth/login", json={"username": USER, "password": PASS})
    print(f"   status={r.status_code}")
    assert r.status_code == 200, r.text

    print("== 5. logout, change password, login with OLD password ==")
    client.post("/api/v1/auth/logout")
    r = client.post("/api/v1/auth/login", json={"username": USER, "password": PASS})
    csrf = r.json()["csrf_token"]
    client.headers.update({"X-CSRF-Token": csrf})
    r = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": PASS, "new_password": "SandiBaruKuat99"},
    )
    print(f"   change-password status={r.status_code}")
    assert r.status_code == 200, r.text
    client.post("/api/v1/auth/logout")
    r = client.post("/api/v1/auth/login", json={"username": USER, "password": PASS})
    print(f"   login with OLD password -> status={r.status_code} ({r.json()['detail']})")
    assert r.status_code == 401
    r = client.post(
        "/api/v1/auth/login", json={"username": USER, "password": "SandiBaruKuat99"}
    )
    print(f"   login with NEW password -> status={r.status_code}")
    assert r.status_code == 200, r.text

    print()
    print("PASS: hash stabil antara logout/login; password lama ditolak HANYA setelah diubah.")
    print("=> 'Unauthorized' di server berarti password di DB memang bukan lagi nilai bootstrap.")


# Entering the client context runs the app lifespan (table creation, worker).
with TestClient(app) as client:
    _run_repro(client)
