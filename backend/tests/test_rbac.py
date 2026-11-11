"""Proctor RBAC, exam assignment and permission flags (spec §3.3, §3.4)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from .helpers import add_participant, create_exam


def _create_proctor(client: TestClient, username: str, **permissions) -> dict:
    payload = {
        "username": username,
        "full_name": "Proktor Satu",
        "password": "ProktorRahasia123",
        "permissions": permissions or {"can_start_exam": True, "can_end_exam": True},
    }
    response = client.post("/api/v1/admin/proctors", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _login_as(client: TestClient, username: str, password: str) -> str:
    client.post("/api/v1/auth/logout")
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    csrf = response.json()["csrf_token"]
    client.headers.update({"X-CSRF-Token": csrf})
    return csrf


def test_admin_can_create_proctor(admin_client: TestClient) -> None:
    proctor = _create_proctor(admin_client, "proctor")
    assert proctor["role"] == "PROCTOR"
    assert proctor["assigned_exam_count"] == 0


def test_proctor_cannot_manage_proctors(admin_client: TestClient) -> None:
    _create_proctor(admin_client, "proctor")
    _login_as(admin_client, "proctor", "ProktorRahasia123")

    response = admin_client.post(
        "/api/v1/admin/proctors",
        json={
            "username": "another",
            "full_name": "Lain",
            "password": "ProktorRahasia123",
        },
    )
    assert response.status_code == 403


def test_proctor_only_sees_assigned_exams(admin_client: TestClient) -> None:
    exam_a = create_exam(admin_client, exam_code="EXG-2026-101", name="Ujian A")
    create_exam(admin_client, exam_code="EXG-2026-102", name="Ujian B")
    proctor = _create_proctor(admin_client, "proctor")
    assign = admin_client.post(
        f"/api/v1/admin/exams/{exam_a['id']}/proctors",
        json={"proctor_user_id": proctor["id"], "permissions": {"can_view_exam": True}},
    )
    assert assign.status_code == 201, assign.text

    _login_as(admin_client, "proctor", "ProktorRahasia123")
    exams = admin_client.get("/api/v1/exams").json()
    assert [exam["exam_code"] for exam in exams] == ["EXG-2026-101"]


def test_proctor_cannot_access_unassigned_exam(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, exam_code="EXG-2026-201")
    _create_proctor(admin_client, "proctor")
    _login_as(admin_client, "proctor", "ProktorRahasia123")

    assert admin_client.get(f"/api/v1/exams/{exam['id']}").status_code == 403
    assert admin_client.get(f"/api/v1/exams/{exam['id']}/monitor").status_code == 403


def test_proctor_without_start_permission_cannot_start(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, exam_code="EXG-2026-301")
    proctor = _create_proctor(
        admin_client,
        "proctor",
        can_view_exam=True,
        can_view_participants=True,
        can_start_exam=False,
        can_end_exam=False,
    )
    admin_client.post(
        f"/api/v1/admin/exams/{exam['id']}/proctors",
        json={
            "proctor_user_id": proctor["id"],
            "permissions": {"can_view_exam": True, "can_view_participants": True, "can_start_exam": False},
        },
    )
    _login_as(admin_client, "proctor", "ProktorRahasia123")

    response = admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    assert response.status_code == 403
    assert "izin" in response.json()["detail"]


def test_proctor_with_start_permission_can_start(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, exam_code="EXG-2026-302")
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    proctor = _create_proctor(admin_client, "proctor")
    admin_client.post(
        f"/api/v1/admin/exams/{exam['id']}/proctors",
        json={
            "proctor_user_id": proctor["id"],
            "permissions": {"can_view_exam": True, "can_start_exam": True},
        },
    )
    _login_as(admin_client, "proctor", "ProktorRahasia123")

    response = admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "LIVE"


def test_proctor_cannot_export_without_permission(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, exam_code="EXG-2026-401")
    proctor = _create_proctor(admin_client, "proctor", can_view_exam=True, can_export_report=False)
    admin_client.post(
        f"/api/v1/admin/exams/{exam['id']}/proctors",
        json={
            "proctor_user_id": proctor["id"],
            "permissions": {"can_view_exam": True, "can_export_report": False},
        },
    )
    _login_as(admin_client, "proctor", "ProktorRahasia123")
    assert admin_client.get(f"/api/v1/exams/{exam['id']}/report.csv").status_code == 403


def test_deactivated_proctor_cannot_login(admin_client: TestClient) -> None:
    proctor = _create_proctor(admin_client, "proctor")
    admin_client.patch(f"/api/v1/admin/proctors/{proctor['id']}", json={"is_active": False})
    admin_client.post("/api/v1/auth/logout")
    response = admin_client.post(
        "/api/v1/auth/login",
        json={"username": "proctor", "password": "ProktorRahasia123"},
    )
    assert response.status_code == 403
