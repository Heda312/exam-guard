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
    # The incident table shows the domain, so it must be exposed on the incident.
    assert incidents[0]["page_host"] == "docs.google.com"
    assert incidents[0]["participant_name"] == "Alek Nurhabib"


def test_monitor_state_incidents_include_host_and_name(admin_client: TestClient) -> None:
    """The live dashboard reads incidents from monitor/state, not /incidents."""
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[
            {
                "client_event_id": "evt-host-1",
                "event_type": "TAB_SWITCH",
                "page_url": "https://chat.example.com/room/1",
            }
        ],
        headers={"X-Participant-Token": token},
    )

    state = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor/state").json()
    assert len(state["incidents"]) == 1
    incident = state["incidents"][0]
    assert incident["page_host"] == "chat.example.com"
    assert incident["participant_name"] == "Alek Nurhabib"


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


def test_monitor_state_bundles_cards_incidents_and_timer(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")
    admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[
            {
                "client_event_id": "state-1",
                "event_type": "TAB_SWITCH",
                "page_url": "https://docs.google.com/forms/d/e/abc/viewform",
            }
        ],
        headers={"X-Participant-Token": token},
    )

    response = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor/state")
    assert response.status_code == 200, response.text
    payload = response.json()

    assert len(payload["cards"]) == 1
    card = payload["cards"][0]
    assert card["participant_session_id"] == ps_id
    assert card["incident_count"] == 1
    assert card["last_incident_type"] == "TAB_SWITCH"
    assert card["last_incident_at"] is not None
    assert card["latest_event_summary"].startswith("Berpindah tab")
    assert card["last_activity_at"] is not None

    assert len(payload["incidents"]) == 1
    assert payload["incidents"][0]["participant_session_id"] == ps_id
    assert payload["timer"]["exam_session_id"] is not None
    assert payload["timer"]["status"] == "LIVE"
    assert payload["timer"]["remaining_seconds"] > 0
    assert payload["server_time"] is not None


def test_monitor_state_is_empty_before_exam_start(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    payload = admin_client.get(f"/api/v1/exams/{exam['id']}/monitor/state").json()
    assert payload["cards"] == []
    assert payload["incidents"] == []
    assert payload["timer"]["remaining_seconds"] == 0


def test_heartbeat_returns_timer_and_status(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    response = admin_client.post(
        "/api/v1/participant/heartbeat",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "MONITORING"
    assert body["remaining_seconds"] > 0
    assert body["ends_at"] is not None


def test_heartbeat_reports_time_expired(admin_client: TestClient, db) -> None:
    from datetime import timedelta

    from app.models import ExamSession, utcnow

    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    exam_session = db.query(ExamSession).filter(ExamSession.exam_id == exam["id"]).one()
    exam_session.ends_at = utcnow() - timedelta(minutes=1)
    db.commit()

    response = admin_client.post(
        "/api/v1/participant/heartbeat",
        json={"participant_session_id": ps_id},
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "TIME_EXPIRED"
    assert body["remaining_seconds"] == 0


def test_heartbeat_is_not_expired_before_exam_start(admin_client: TestClient) -> None:
    """Regression: a registered participant must not be told the exam ended.

    Before the exam starts there is no ExamSession at all, so there is no
    deadline. ``remaining_seconds`` is 0 either way, which previously made the
    participant page open the "waktu ujian habis" modal right after sign-up.
    """
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201, body

    response = admin_client.post(
        "/api/v1/participant/heartbeat",
        json={"participant_session_id": body["participant_session_id"]},
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] not in {"TIME_EXPIRED", "COMPLETED"}
    assert payload["ends_at"] is None
    assert payload["remaining_seconds"] == 0


def test_participant_session_has_no_end_message_before_start(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201, body

    response = admin_client.get(
        f"/api/v1/participant/session/{body['participant_session_id']}",
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 200, response.text
    session = response.json()
    assert session["ends_at"] is None
    assert "Waktu ujian telah berakhir." not in session["messages"]


def test_clipboard_attempts_create_incidents(admin_client: TestClient) -> None:
    """Copy/paste attempts from the extension become reviewable incidents."""
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    response = admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[
            {
                "client_event_id": "clip-copy-1",
                "event_type": "COPY_ATTEMPT",
                "page_url": "https://docs.google.com/forms/d/e/abc/viewform",
                "metadata": {"reason": "clipboard_blocked"},
            },
            {
                "client_event_id": "clip-paste-1",
                "event_type": "PASTE_ATTEMPT",
                "page_url": "https://docs.google.com/forms/d/e/abc/viewform",
                "metadata": {"reason": "clipboard_blocked"},
            },
        ],
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 201, response.text
    stored = response.json()
    # Bursts inside the correlation window merge into one episode.
    assert len({event["incident_id"] for event in stored}) == 1
    assert all(event["incident_id"] for event in stored)

    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert len(incidents) == 1
    assert incidents[0]["incident_type"] == "COPY_ATTEMPT"
    assert incidents[0]["event_count"] == 2
    assert incidents[0]["review_status"] == "UNREVIEWED"


def test_clipboard_episode_closes_and_reopens(admin_client: TestClient) -> None:
    """FOCUS_RESTORED closes the clipboard episode; a later cut starts a new one."""
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")
    url = f"/api/v1/participant/events?participant_session_id={ps_id}"
    headers = {"X-Participant-Token": token}

    admin_client.post(
        url,
        json=[{"client_event_id": "clip-a", "event_type": "COPY_ATTEMPT"}],
        headers=headers,
    )
    admin_client.post(
        url,
        json=[{"client_event_id": "clip-close", "event_type": "FOCUS_RESTORED"}],
        headers=headers,
    )
    admin_client.post(
        url,
        json=[{"client_event_id": "clip-b", "event_type": "CUT_ATTEMPT"}],
        headers=headers,
    )

    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert len(incidents) == 2
    assert {incident["incident_type"] for incident in incidents} == {
        "COPY_ATTEMPT",
        "CUT_ATTEMPT",
    }
    closed = next(i for i in incidents if i["incident_type"] == "COPY_ATTEMPT")
    assert closed["ended_at"] is not None


def test_guard_tampered_creates_incident(admin_client: TestClient) -> None:
    """The copy-guard probe reports another extension neutralising the guard."""
    exam = create_exam(admin_client)
    ps_id, token = _start_monitoring(admin_client, exam, "Alek Nurhabib")

    response = admin_client.post(
        f"/api/v1/participant/events?participant_session_id={ps_id}",
        json=[
            {
                "client_event_id": "guard-tamper-1",
                "event_type": "GUARD_TAMPERED",
                "page_url": "https://docs.google.com/forms/d/e/abc/viewform",
                "metadata": {"reason": "copy_guard_tampered", "seen": [False, False, True]},
            },
        ],
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 201, response.text
    stored = response.json()
    assert stored[0]["incident_id"]

    incidents = admin_client.get(f"/api/v1/exams/{exam['id']}/incidents").json()
    assert len(incidents) == 1
    assert incidents[0]["incident_type"] == "GUARD_TAMPERED"
    assert incidents[0]["review_status"] == "UNREVIEWED"
