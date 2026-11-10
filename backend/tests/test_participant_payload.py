"""Participant-facing payload rules: NPM masking and roster protection (spec §10.2, §9.3)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from .helpers import add_participant, create_exam, register_participant


def test_participant_npm_is_masked(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib", npm="20210001")

    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib", npm="20210001")
    assert status == 201
    assert body["participant"]["npm"] == "20****01"


def test_participant_registration_does_not_modify_roster(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    entry = add_participant(admin_client, exam["id"], "Alek Nurhabib", npm="20210001")

    register_participant(admin_client, exam["exam_code"], "Alek Nurhabib", npm="99999999")

    roster = admin_client.get(f"/api/v1/exams/{exam['id']}/roster").json()
    assert len(roster) == 1
    assert roster[0]["full_name"] == "Alek Nurhabib"
    assert roster[0]["npm"] == "20210001"
    assert roster[0]["id"] == entry["id"]


def test_participant_payload_hides_incident_counts(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201
    serialized = str(body)
    assert "incident" not in serialized.lower()


def test_public_exam_endpoint_exposes_no_roster(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")

    response = admin_client.get(f"/api/v1/participant/exam/{exam['exam_code']}/public")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "exam_code",
        "name",
        "status",
        "duration_minutes",
        "registration_open",
        "registration_message",
        "scheduled_at",
        "server_time",
    }
    assert "Alek" not in response.text
