"""Exam lifecycle, server-authoritative timer and expiry (spec §8, §12, §13)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import threading

from fastapi.testclient import TestClient
from sqlalchemy import select

from .helpers import add_participant, create_exam, register_participant


def test_exam_code_is_generated_when_omitted(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, exam_code=None)
    assert exam["exam_code"].startswith("EXG-")
    assert exam["status"] == "REGISTRATION_OPEN"


def test_concurrent_first_registration_reuses_one_exam_session(admin_client, monkeypatch):
    from app.database import SessionLocal
    from app.models import Exam, ExamSession
    from app.services import exams

    exam = create_exam(admin_client)
    gate = threading.Barrier(10)
    get_active = exams.get_active_exam_session

    def synchronized_lookup(db, exam_id):
        result = get_active(db, exam_id)
        if not db.info.get('initial_lookup_done'):
            db.info['initial_lookup_done'] = True
            gate.wait(timeout=5)
        return result

    monkeypatch.setattr(exams, 'get_active_exam_session', synchronized_lookup)
    with SessionLocal() as db:
        original_updated_at = db.get(Exam, exam['id']).updated_at

    def create_session(_):
        with SessionLocal() as db:
            row = db.get(Exam, exam['id'])
            session = exams.get_or_create_exam_session(db, row)
            db.commit()
            return session.id

    with ThreadPoolExecutor(max_workers=10) as executor:
        session_ids = list(executor.map(create_session, range(10)))
    assert len(set(session_ids)) == 1
    with SessionLocal() as db:
        sessions = db.scalars(select(ExamSession).where(ExamSession.exam_id == exam['id'])).all()
        assert len(sessions) == 1
        assert sessions[0].started_at is None
        assert sessions[0].ends_at is None
        assert db.get(Exam, exam['id']).updated_at == original_updated_at


def test_duplicate_exam_code_rejected(admin_client: TestClient) -> None:
    create_exam(admin_client, exam_code="EXG-2026-777")
    response = admin_client.post(
        "/api/v1/exams",
        json={"name": "Lain", "exam_code": "EXG-2026-777", "duration_minutes": 30},
    )
    assert response.status_code == 409


def test_google_forms_url_must_be_https_and_allowlisted(admin_client: TestClient) -> None:
    bad_scheme = admin_client.post(
        "/api/v1/exams",
        json={
            "name": "Ujian",
            "exam_code": "EXG-2026-901",
            "duration_minutes": 30,
            "google_forms_url": "http://docs.google.com/forms/d/e/abc/viewform",
        },
    )
    assert bad_scheme.status_code == 422

    bad_host = admin_client.post(
        "/api/v1/exams",
        json={
            "name": "Ujian",
            "exam_code": "EXG-2026-902",
            "duration_minutes": 30,
            "google_forms_url": "https://evil.example.com/form",
        },
    )
    assert bad_host.status_code == 422


def test_start_sets_server_authoritative_deadline(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, duration_minutes=90)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    response = admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "LIVE"
    assert body["exam_session_id"], "exam_session_id must be exposed for the WebSocket feed"
    started = datetime.fromisoformat(body["started_at"])
    ends = datetime.fromisoformat(body["ends_at"])
    assert ends - started == timedelta(minutes=90)

    timer = admin_client.get(f"/api/v1/exams/{exam['id']}/timer").json()
    assert timer["remaining_seconds"] > 89 * 60
    assert timer["exam_session_id"] == body["exam_session_id"]


def test_start_requires_forms_url(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, google_forms_url="")
    response = admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    assert response.status_code == 409


def test_start_is_idempotent_for_deadline(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    first = admin_client.post(f"/api/v1/exams/{exam['id']}/start").json()
    second = admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    assert second.status_code == 409
    assert first["ends_at"] is not None


def test_end_exam_completes_participants(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    response = admin_client.post(f"/api/v1/exams/{exam['id']}/end")
    assert response.status_code == 200
    assert response.json()["status"] == "COMPLETED"

    cards = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor").json()
    assert [card["status"] for card in cards] == ["COMPLETED"]


def test_invalid_status_transition_rejected(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    response = admin_client.post(f"/api/v1/exams/{exam['id']}/status", json={"status": "LIVE"})
    # LIVE requires can_start_exam and a valid transition from REGISTRATION_OPEN.
    assert response.status_code == 409


def test_expiry_worker_closes_sessions(admin_client: TestClient, db) -> None:
    """The official timer continues while disconnected and expires server-side."""
    import asyncio

    from app.models import ExamSession, ParticipantSession
    from app.worker import sweep_once

    exam = create_exam(admin_client, duration_minutes=90)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201

    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    exam_session = db.scalar(select(ExamSession).where(ExamSession.exam_id == exam["id"]))
    exam_session.ends_at = datetime.now(timezone.utc) - timedelta(seconds=5)
    db.commit()

    asyncio.run(sweep_once())

    db.expire_all()
    ps = db.scalar(
        select(ParticipantSession).where(ParticipantSession.id == body["participant_session_id"])
    )
    assert ps.status == "TIME_EXPIRED"
    assert ps.completed_at is not None
    refreshed = db.get(ExamSession, exam_session.id)
    assert refreshed.completed_at is not None


def test_disconnected_participant_is_not_classified_as_cheating(admin_client: TestClient, db) -> None:
    import asyncio

    from app.models import ParticipantSession
    from app.worker import sweep_once

    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    _, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    admin_client.post(
        "/api/v1/participant/ready",
        json={"participant_session_id": body["participant_session_id"]},
        headers={"X-Participant-Token": token},
    )
    admin_client.post(
        "/api/v1/participant/monitoring/start",
        json={"participant_session_id": body["participant_session_id"]},
        headers={"X-Participant-Token": token},
    )

    ps = db.get(ParticipantSession, body["participant_session_id"])
    ps.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    db.commit()

    asyncio.run(sweep_once())
    db.expire_all()
    ps = db.get(ParticipantSession, body["participant_session_id"])
    assert ps.status == "CONNECTION_LOST"
    # No incident is created for a connection loss.
    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert incidents == []
