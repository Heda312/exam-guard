"""Audit entries keep readable names and accurate transition context."""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog

from .helpers import create_exam


def _latest(db: Session, action: str) -> AuditLog:
    entries = db.scalars(
        select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.created_at)
    ).all()
    assert entries, f"no audit entry for {action}"
    return entries[-1]


def test_proctor_audit_metadata_uses_names(admin_client: TestClient, db: Session) -> None:
    created = admin_client.post(
        "/api/v1/admin/proctors",
        json={"username": "lista", "full_name": "Lista", "password": "Lista123456"},
    )
    assert created.status_code == 201, created.text
    exam = create_exam(admin_client, name="Ujian Audit")
    assigned = admin_client.post(
        f"/api/v1/admin/exams/{exam['id']}/proctors",
        json={"proctor_user_id": created.json()["id"], "permissions": {"can_view_exam": True}},
    )
    assert assigned.status_code == 201, assigned.text

    entry = _latest(db, "exam.proctor_assigned")
    assert entry.resource_id == exam["id"]
    assert entry.metadata_json["proctor_name"] == "Lista"
    assert entry.metadata_json["proctor_username"] == "lista"
    assert "proctor_user_id" not in entry.metadata_json
    assert entry.actor_label == "admin"

    created_entry = _latest(db, "proctor.created")
    assert created_entry.metadata_json["full_name"] == "Lista"

    removed = admin_client.delete(
        f"/api/v1/admin/exams/{exam['id']}/proctors/{assigned.json()['id']}"
    )
    assert removed.status_code == 200
    unassigned = _latest(db, "exam.proctor_unassigned")
    assert unassigned.metadata_json["proctor_name"] == "Lista"


def test_status_change_audit_keeps_previous_status(admin_client: TestClient, db: Session) -> None:
    exam = create_exam(admin_client, name="Ujian Transisi", status="DRAFT")
    response = admin_client.post(
        f"/api/v1/exams/{exam['id']}/status", json={"status": "REGISTRATION_OPEN"}
    )
    assert response.status_code == 200, response.text
    entry = _latest(db, "exam.status_changed")
    assert entry.metadata_json["from"] == "DRAFT"
    assert entry.metadata_json["to"] == "REGISTRATION_OPEN"
    assert entry.metadata_json["exam_code"] == exam["exam_code"]
