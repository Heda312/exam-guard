"""Timestamp serialization must always be timezone-aware UTC.

Regression guard for the SQLite naive-datetime bug that made the participant
countdown render 00:00.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from .helpers import add_participant, create_exam, register_participant


def test_participant_timestamps_are_timezone_aware(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    status, body, _ = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    assert status == 201

    server_time = body["server_time"]
    assert server_time.endswith("Z") or "+" in server_time, server_time

    parsed = datetime.fromisoformat(server_time.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None
    # server_time must be close to real now, not 1970 and not naive.
    assert abs(datetime.now(timezone.utc) - parsed) < timedelta(minutes=5)


def test_exam_deadline_is_timezone_aware(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, duration_minutes=45)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")

    started = admin_client.post(f"/api/v1/exams/{exam['id']}/start").json()
    ends_at = datetime.fromisoformat(started["ends_at"].replace("Z", "+00:00"))
    assert ends_at.tzinfo is not None
    assert ends_at > datetime.now(timezone.utc)


def test_participant_ends_at_present_after_start(admin_client: TestClient) -> None:
    exam = create_exam(admin_client, duration_minutes=60)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    _, body, token = register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    response = admin_client.post(
        "/api/v1/participant/session",
        json={"participant_session_id": body["participant_session_id"]},
        headers={"X-Participant-Token": token},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ends_at"] is not None
    ends_at = datetime.fromisoformat(payload["ends_at"].replace("Z", "+00:00"))
    server_time = datetime.fromisoformat(payload["server_time"].replace("Z", "+00:00"))
    remaining = (ends_at - server_time).total_seconds()
    # The countdown must reflect the real remaining duration, not zero.
    assert 55 * 60 < remaining <= 60 * 60, remaining
