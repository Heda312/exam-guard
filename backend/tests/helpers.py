"""Shared helpers for building exam fixtures through the public API."""
from __future__ import annotations

from fastapi.testclient import TestClient


def create_exam(
    client: TestClient,
    *,
    name: str = "Ujian Tengah Semester",
    exam_code: str | None = "EXG-2026-001",
    duration_minutes: int = 90,
    status: str = "REGISTRATION_OPEN",
    google_forms_url: str = "https://docs.google.com/forms/d/e/abc/viewform",
) -> dict:
    payload = {
        "name": name,
        "duration_minutes": duration_minutes,
        "status": status,
        "google_forms_url": google_forms_url,
    }
    if exam_code is not None:
        payload["exam_code"] = exam_code
    response = client.post("/api/v1/exams", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def add_participant(client: TestClient, exam_id: str, full_name: str, npm: str | None = None) -> dict:
    response = client.post(
        f"/api/v1/exams/{exam_id}/roster",
        json={"full_name": full_name, "npm": npm},
    )
    assert response.status_code == 201, response.text
    return response.json()


def register_participant(
    client: TestClient,
    exam_code: str,
    full_name: str,
    *,
    npm: str | None = None,
    commitment: bool = True,
) -> tuple[int, dict | None, str | None]:
    response = client.post(
        "/api/v1/participant/register",
        json={
            "exam_code": exam_code,
            "full_name": full_name,
            "npm": npm,
            "commitment_accepted": commitment,
        },
    )
    token = response.headers.get("X-Participant-Token")
    body = response.json() if response.content else None
    return response.status_code, body, token
