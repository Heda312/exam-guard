"""Participant registration rules (spec §6, §7)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from .helpers import add_participant, create_exam, register_participant


def test_exam_id_alone_is_not_enough(admin_client: TestClient) -> None:
    """Possessing the Exam ID must not grant access (spec §1)."""
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, _ = register_participant(admin_client, exam["exam_code"], "Nama Tidak Ada")
    assert status == 404
    assert body["detail"] == "Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama."


def test_registration_matches_normalized_name(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    for variant in ["alek nurhabib", "aleknurhabib", "ALeKNurHaBIb", "  Alek   Nurhabib  "]:
        status, body, token = register_participant(admin_client, exam["exam_code"], variant)
        assert status == 201, body
        # Canonical roster name is returned, never the raw input.
        assert body["participant"]["full_name"] == "Alek Nurhabib"
        assert token


def test_registration_rejects_typo(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabip")
    assert status == 404
    assert body["detail"] == "Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama."


def test_npm_is_not_a_validation_key(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Siti Aminah", npm="2021001")

    # Wrong NPM, correct name -> accepted.
    status, body, _ = register_participant(admin_client, exam["exam_code"], "Siti Aminah", npm="9999999")
    assert status == 201
    # Correct NPM, wrong name -> rejected.
    status, _, _ = register_participant(admin_client, exam["exam_code"], "Budi Santoso", npm="2021001")
    assert status == 404


def test_registration_requires_commitment(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib", commitment=False)
    assert status == 422
    assert "integritas" in body["detail"].lower()
    assert token is None


def test_registration_closed_when_exam_draft(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, status="DRAFT")
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 409
    assert "belum dibuka" in body["detail"]


def test_registration_closed_when_exam_completed(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")
    admin_client.post(f"/api/v1/exams/{exam['id']}/end")
    response = admin_client.post(
        "/api/v1/participant/register",
        json={
            "exam_code": exam["exam_code"],
            "full_name": "Alek Nurhabib",
            "commitment_accepted": True,
        },
    )
    assert response.status_code == 409
    assert "berakhir" in response.json()["detail"]
    # The page renders a friendly "exam completed" popup instead of a red error.
    assert response.headers["X-Error-Code"] == "exam_ended"


def test_registration_stays_open_while_exam_is_live(admin_client: TestClient) -> None:
    """Late arrival must be allowed, then flagged — not blocked.

    A participant who only reaches the page after the proctor pressed start used
    to be rejected with "Ujian sudah dimulai." and could never join.
    """
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201, body
    assert token
    assert body["exam_status"] == "LIVE"


def test_late_participant_can_reach_monitoring(admin_client: TestClient) -> None:
    """The full late path: register while LIVE, then ready + monitoring start.

    This is the exact sequence the "Buka ujian" button triggers, and it used to
    fail silently because mark_ready rejected the WAITING status.
    """
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201, body
    ps_id = body["participant_session_id"]

    ready = admin_client.post(
        "/api/v1/participant/ready",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    assert ready.status_code == 200, ready.text

    started = admin_client.post(
        "/api/v1/participant/monitoring/start",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "MONITORING"


def test_late_join_is_flagged_on_the_monitoring_card(admin_client: TestClient, db) -> None:
    """The card carries is_late so proctors see who arrived after the start."""
    from datetime import timedelta

    from app.models import ExamSession, utcnow

    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201, body

    # Pretend the exam started long before this participant registered.
    exam_session = db.query(ExamSession).filter(ExamSession.exam_id == exam["id"]).one()
    exam_session.started_at = utcnow() - timedelta(minutes=10)
    db.commit()

    state = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor/state").json()
    assert len(state["cards"]) == 1
    card = state["cards"][0]
    assert card["is_late"] is True
    assert card["joined_at"] is not None


def test_on_time_join_is_not_flagged(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201, body
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    ps_id = body["participant_session_id"]
    admin_client.post(
        "/api/v1/participant/ready",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    admin_client.post(
        "/api/v1/participant/monitoring/start",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )

    state = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor/state").json()
    assert state["cards"][0]["is_late"] is False


def test_unknown_exam_id_is_generic(admin_client: TestClient) -> None:
    status, body, _ = register_participant(admin_client, "EXG-9999-999", "Alek Nurhabib")
    assert status == 404
    assert body["detail"] == "Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama."


def test_duplicate_registration_resumes_session(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    first_status, first_body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    second_status, second_body, _ = register_participant(admin_client, exam["exam_code"], "alek nurhabib")
    assert first_status == 201 and second_status == 201
    assert first_body["participant_session_id"] == second_body["participant_session_id"]


def test_ambiguous_roster_is_rejected(admin_client: TestClient, db) -> None:
    """Two roster rows that normalize identically must block registration."""
    from app.models import ExamParticipant, Participant

    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    # Bypass the API guard to simulate legacy/imported duplicate data.
    from app.names import normalize_name

    participant = Participant(
        full_name="Alek  Nurhabib",
        normalized_name=normalize_name("Alek  Nurhabib"),
    )
    db.add(participant)
    db.flush()
    db.add(
        ExamParticipant(
            exam_id=exam["id"],
            participant_id=participant.id,
            normalized_name=participant.normalized_name,
        )
    )
    db.commit()

    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 404
    assert body["detail"] == "Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama."


def test_registration_is_rate_limited(admin_client: TestClient) -> None:
    from app.api import participant as participant_module

    participant_module.register_limiter.limit = 3
    participant_module.register_limiter.reset()
    try:
        exam = create_exam(admin_client)
        add_participant(admin_client, exam["id"], "Alek Nurhabib")
        statuses = [
            register_participant(admin_client, exam["exam_code"], "Salah Nama")[0] for _ in range(6)
        ]
        assert 429 in statuses
    finally:
        participant_module.register_limiter.limit = 1000
        participant_module.register_limiter.reset()
