"""Destructive admin actions: delete roster entry, proctor and exam.

These are hard deletes, so the tests also assert that dependent rows disappear
and that a live exam is protected.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import Exam, ExamParticipant, ExamProctor, User

from .helpers import add_participant, create_exam, register_participant


def _create_proctor(client: TestClient, username: str = "proktor1") -> dict:
    response = client.post(
        "/api/v1/admin/proctors",
        json={
            "username": username,
            "full_name": "Proktor Satu",
            "password": "ProktorRahasia123",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_delete_roster_entry_removes_participant_from_exam(
    admin_client: TestClient, db
) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    add_participant(admin_client, exam["id"], "Budi Santoso")

    roster = admin_client.get(f"/api/v1/exams/{exam['id']}/roster").json()
    assert len(roster) == 2
    target = next(entry for entry in roster if entry["full_name"] == "Alek Nurhabib")

    response = admin_client.delete(f"/api/v1/exams/{exam['id']}/roster/{target['id']}")
    assert response.status_code == 200, response.text

    remaining = admin_client.get(f"/api/v1/exams/{exam['id']}/roster").json()
    assert [entry["full_name"] for entry in remaining] == ["Budi Santoso"]

    # The exam itself survives.
    assert db.get(Exam, exam["id"]) is not None


def test_deleted_participant_cannot_register_again(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    roster = admin_client.get(f"/api/v1/exams/{exam['id']}/roster").json()
    admin_client.delete(f"/api/v1/exams/{exam['id']}/roster/{roster[0]['id']}")

    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    # Unknown identity is deliberately reported as a generic 404 (no roster leak).
    assert status in {403, 404}, body
    assert "Identitas tidak dapat diverifikasi" in body["detail"]


def test_delete_proctor_removes_account_and_assignments(
    admin_client: TestClient, db
) -> None:
    exam = create_exam(admin_client)
    proctor = _create_proctor(admin_client)

    assigned = admin_client.post(
        f"/api/v1/admin/exams/{exam['id']}/proctors",
        json={"proctor_user_id": proctor["id"], "permissions": {"can_view_exam": True}},
    )
    assert assigned.status_code == 201, assigned.text

    response = admin_client.delete(f"/api/v1/admin/proctors/{proctor['id']}")
    assert response.status_code == 200, response.text

    assert db.get(User, proctor["id"]) is None
    assignments = db.scalars(
        select(ExamProctor).where(ExamProctor.proctor_user_id == proctor["id"])
    ).all()
    assert assignments == []

    # The login is gone too.
    admin_client.post("/api/v1/auth/logout")
    login = admin_client.post(
        "/api/v1/auth/login",
        json={"username": "proktor1", "password": "ProktorRahasia123"},
    )
    assert login.status_code == 401


def test_delete_exam_removes_roster_and_sessions(admin_client: TestClient, db) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    response = admin_client.delete(f"/api/v1/exams/{exam['id']}")
    assert response.status_code == 200, response.text

    assert db.get(Exam, exam["id"]) is None
    links = db.scalars(select(ExamParticipant).where(ExamParticipant.exam_id == exam["id"])).all()
    assert links == []

    missing = admin_client.get(f"/api/v1/exams/{exam['id']}")
    assert missing.status_code == 404


def test_live_exam_cannot_be_deleted(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    started = admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    assert started.status_code == 200, started.text

    response = admin_client.delete(f"/api/v1/exams/{exam['id']}")
    assert response.status_code == 400
    assert "LIVE" in response.json()["detail"]


def test_proctor_cannot_delete_exam(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    proctor = _create_proctor(admin_client, "proktor2")
    admin_client.post(
        f"/api/v1/admin/exams/{exam['id']}/proctors",
        json={
            "proctor_user_id": proctor["id"],
            "permissions": {"can_view_exam": True, "can_start_exam": True},
        },
    )

    admin_client.post("/api/v1/auth/logout")
    login = admin_client.post(
        "/api/v1/auth/login",
        json={"username": "proktor2", "password": "ProktorRahasia123"},
    )
    assert login.status_code == 200, login.text
    admin_client.headers.update({"X-CSRF-Token": login.json()["csrf_token"]})

    response = admin_client.delete(f"/api/v1/exams/{exam['id']}")
    assert response.status_code == 403
