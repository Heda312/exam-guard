"""First-run setup, login, CSRF and RBAC (spec §3, §5.1)."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import __version__


def test_public_version_matches_release_files(client: TestClient) -> None:
    root = Path(__file__).resolve().parents[2]
    package = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "frontend/package-lock.json").read_text(encoding="utf-8"))
    manifest = json.loads((root / "extension/manifest.json").read_text(encoding="utf-8"))
    assert package["version"] == lock["version"] == lock["packages"][""]["version"] == manifest["version"] == __version__
    for path in ("/health", "/api/v1/meta"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json()["version"] == __version__
    assert client.get("/api/openapi.json").json()["info"]["version"] == __version__


def test_setup_status_requires_secret_configuration(client: TestClient) -> None:
    response = client.get("/api/v1/setup/status")
    assert response.status_code == 200
    body = response.json()
    assert body["setup_required"] is True
    assert body["setup_secret_configured"] is True


def test_setup_rejects_wrong_secret(client: TestClient) -> None:
    response = client.post(
        "/api/v1/setup",
        json={
            "setup_secret": "wrong-secret",
            "username": "admin",
            "full_name": "Admin",
            "password": "AdminRahasia123",
        },
    )
    assert response.status_code == 403


def test_setup_rejects_weak_password(client: TestClient) -> None:
    response = client.post(
        "/api/v1/setup",
        json={
            "setup_secret": "test-setup-secret",
            "username": "admin",
            "full_name": "Admin",
            "password": "short",
        },
    )
    assert response.status_code == 422


def test_setup_succeeds_once_and_sets_http_only_cookie(client: TestClient) -> None:
    response = client.post(
        "/api/v1/setup",
        json={
            "setup_secret": "test-setup-secret",
            "username": "admin",
            "full_name": "Admin Utama",
            "password": "AdminRahasia123",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["user"]["role"] == "ADMIN"
    assert "password" not in body["user"]

    set_cookie = " ".join(response.headers.get_list("set-cookie"))
    assert "HttpOnly" in set_cookie

    # Setup is disabled permanently after the first successful run.
    second = client.post(
        "/api/v1/setup",
        json={
            "setup_secret": "test-setup-secret",
            "username": "other",
            "full_name": "Other Admin",
            "password": "AdminRahasia123",
        },
    )
    assert second.status_code == 409


def test_login_and_me(admin_client: TestClient) -> None:
    admin_client.post("/api/v1/auth/logout")
    response = admin_client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "AdminRahasia123"},
    )
    assert response.status_code == 200
    csrf = response.json()["csrf_token"]
    admin_client.headers.update({"X-CSRF-Token": csrf})

    me = admin_client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["permissions"]["is_admin"] is True


def test_login_rejects_bad_password(admin_client: TestClient) -> None:
    admin_client.post("/api/v1/auth/logout")
    response = admin_client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "SalahBanget123"},
    )
    assert response.status_code == 401


def test_state_change_requires_csrf(admin_client: TestClient) -> None:
    admin_client.headers.pop("X-CSRF-Token", None)
    response = admin_client.post("/api/v1/exams", json={"name": "Ujian", "duration_minutes": 30})
    assert response.status_code == 403
    assert "CSRF" in response.json()["detail"]


def test_unauthenticated_dashboard_access_denied(client: TestClient) -> None:
    assert client.get("/api/v1/exams").status_code == 401
    assert client.get("/api/v1/dashboard/overview").status_code == 401


def test_audit_log_records_failed_login(client: TestClient, admin_client: TestClient) -> None:
    admin_client.post("/api/v1/auth/logout")
    admin_client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "SalahBanget123"},
    )
    admin_client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "AdminRahasia123"},
    )
    logs = admin_client.get("/api/v1/audit-logs?action=auth.login_failed")
    assert logs.status_code == 200
    assert len(logs.json()) >= 1
    # Passwords must never be logged.
    assert "SalahBanget123" not in logs.text
