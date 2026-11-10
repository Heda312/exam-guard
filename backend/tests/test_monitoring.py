"""Monitoring events, incident correlation and review (spec §14, §15, §16)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from .helpers import add_participant, create_exam, register_participant


def _start_monitoring(client: TestClient, exam: dict, participant_name: str) -> tuple[str, str]:
    add_participant(client, exam["id"], participant_name)
    status, body, token = register_participant(client, exam["exam_code"], participant_name)
    assert status == 201, body
    ps_id = body["participant_session_id"]
    client.post(f"/api/v1/exams/{exam['id']}/start")
    ready = client.post(
        "/api/v1/participant/ready",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    assert ready.status_code == 200, ready.text
    started = client.post(
        "/api/v1/participant/monitoring/start",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "MONITORING"
    return ps_id, token


def test_monitoring_cannot_start_before_ready(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    _, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    response = admin_client.post(
        "/api/v1/participant/monitoring/start",
        json={"participant_session_id": body["participant_session_id"]},
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 409
    assert "belum terverifikasi" in response.json()["detail"]


def test_event_ingestion_requires_valid_token(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, _ = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    response = admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[{"event_type": "TAB_SWITCH"}],
        headers={"X-Participant-Token": "token-palsu"},
    )
    assert response.status_code == 403


def test_event_creates_incident(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    response = admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[
            {
                "client_event_id": "evt-1",
                "event_type": "TAB_SWITCH",
                "page_url": "https://docs.google.com/forms/d/e/abc/viewform?token=secret",
                "metadata": {"from_tab": 1},
            }
        ],
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 201, response.text
    stored = response.json()[0]
    # Data minimisation: only the host is persisted, never the full URL.
    assert stored["page_host"] == "docs.google.com"
    assert "secret" not in response.text
    assert stored["incident_id"] is not None

    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert len(incidents) == 1
    assert incidents[0]["incident_type"] == "TAB_SWITCH"
    assert incidents[0]["review_status"] == "UNREVIEWED"


def test_events_are_idempotent_by_client_event_id(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")
    payload = [{"client_event_id": "dupe-1", "event_type": "NEW_TAB"}]

    first = admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=payload,
        headers={"X-Participant-Token": token},
    )
    second = admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=payload,
        headers={"X-Participant-Token": token},
    )
    assert first.status_code == 201 and second.status_code == 201
    assert first.json()[0]["id"] == second.json()[0]["id"]

    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert len(incidents) == 1
    assert incidents[0]["event_count"] == 1


def test_focus_restored_closes_incident_episode(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[{"client_event_id": "e1", "event_type": "FOCUS_LOST"}],
        headers={"X-Participant-Token": token},
    )
    admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[{"client_event_id": "e2", "event_type": "FOCUS_RESTORED"}],
        headers={"X-Participant-Token": token},
    )
    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert len(incidents) == 1
    assert incidents[0]["ended_at"] is not None


def test_incident_review_records_audit(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")
    admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[{"client_event_id": "r1", "event_type": "WINDOW_MINIMIZED"}],
        headers={"X-Participant-Token": token},
    )
    incident = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()[0]

    response = admin_client.patch(
        f"/api/v1/incidents/{incident['id']}",
        json={"review_status": "REVIEWED", "notes": "Peserta pindah tab untuk menjawab telepon."},
    )
    assert response.status_code == 200
    assert response.json()["review_status"] == "REVIEWED"

    logs = admin_client.get("/api/v1/audit-logs?action=incident.reviewed").json()
    assert len(logs) == 1


def test_monitor_cards_show_connection_state(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")
    admin_client.post(
        "/api/v1/participant/heartbeat",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )

    cards = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor").json()
    assert len(cards) == 1
    assert cards[0]["connection_state"] == "ONLINE"
    assert cards[0]["online"] is True

    admin_client.post(
        "/api/v1/participant/disconnect",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    cards = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor").json()
    assert cards[0]["status"] == "CONNECTION_LOST"
    assert cards[0]["online"] is False
