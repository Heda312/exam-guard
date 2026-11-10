"""Roster CSV import and report export (spec §9, §20)."""
from __future__ import annotations

from io import BytesIO

from fastapi.testclient import TestClient

from .helpers import add_participant, create_exam, register_participant

CSV_OK = (
    "full_name,npm,email,group_name\n"
    "Alek Nurhabib,2021001,alek@example.com,Kelas A\n"
    "Siti Aminah,2021002,,Kelas B\n"
    "Budi Santoso,,,Kelas B\n"
)


def test_import_preview_does_not_persist(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    files = {"file": ("roster.csv", CSV_OK.encode("utf-8"), "text/csv")}
    response = admin_client.post(f"/api/v1/exams/{exam['id']}/roster/import/preview", files=files)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total_rows"] == 3
    assert body["valid_rows"] == 3
    assert admin_client.get(f"/api/v1/exams/{exam['id']}/roster").json() == []


def test_import_commit_creates_participants(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    files = {"file": ("roster.csv", CSV_OK.encode("utf-8"), "text/csv")}
    response = admin_client.post(f"/api/v1/exams/{exam['id']}/roster/import", files=files)
    assert response.status_code == 200, response.text
    assert response.json()["imported"] == 3

    roster = admin_client.get(f"/api/v1/exams/{exam['id']}/roster").json()
    assert len(roster) == 3
    assert {row["full_name"] for row in roster} == {"Alek Nurhabib", "Siti Aminah", "Budi Santoso"}


def test_import_flags_duplicates_in_file(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    content = (
        "full_name,npm\n"
        "Alek Nurhabib,2021001\n"
        "alek  nurhabib,2021002\n"
    )
    files = {"file": ("roster.csv", content.encode("utf-8"), "text/csv")}
    preview = admin_client.post(f"/api/v1/exams/{exam['id']}/roster/import/preview", files=files).json()
    statuses = [row["status"] for row in preview["rows"]]
    assert statuses == ["ok", "duplicate_in_file"]
    assert preview["valid_rows"] == 1


def test_import_flags_existing_roster_duplicate(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    files = {"file": ("roster.csv", CSV_OK.encode("utf-8"), "text/csv")}
    preview = admin_client.post(f"/api/v1/exams/{exam['id']}/roster/import/preview", files=files).json()
    duplicate = [row for row in preview["rows"] if row["status"] == "duplicate_in_roster"]
    assert len(duplicate) == 1


def test_import_requires_full_name_column(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    files = {"file": ("roster.csv", b"npm,email\n2021001,a@example.com\n", "text/csv")}
    response = admin_client.post(f"/api/v1/exams/{exam['id']}/roster/import/preview", files=files)
    assert response.status_code == 422
    assert "full_name" in response.json()["detail"]


def test_roster_edit_preserves_unique_normalized_names(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    entry = add_participant(admin_client, exam["id"], "Siti Aminah")

    response = admin_client.patch(
        f"/api/v1/exams/{exam['id']}/roster/{entry['id']}",
        json={"full_name": "alek nurhabib"},
    )
    assert response.status_code == 409


def test_npm_is_not_unique_across_roster(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    first = admin_client.post(
        f"/api/v1/exams/{exam['id']}/roster",
        json={"full_name": "Alek Nurhabib", "npm": "2021001"},
    )
    second = admin_client.post(
        f"/api/v1/exams/{exam['id']}/roster",
        json={"full_name": "Siti Aminah", "npm": "2021001"},
    )
    assert first.status_code == 201
    assert second.status_code == 201


def test_csv_report_export(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib", npm="2021001")
    register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    response = admin_client.get(f"/api/v1/exams/{exam['id']}/report.csv")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    assert "attachment" in response.headers["content-disposition"]
    text = response.content.decode("utf-8")
    assert "Alek Nurhabib" in text
    assert "commitment_accepted" in text
    assert "yes" in text


def test_xlsx_report_export(admin_client: TestClient) -> None:
    exam = create_exam(admin_client)
    add_participant(admin_client, exam["id"], "Alek Nurhabib")
    register_participant(admin_client, exam["exam_code"], "Alek Nurhabib")
    admin_client.post(f"/api/v1/exams/{exam['id']}/start")

    response = admin_client.get(f"/api/v1/exams/{exam['id']}/report.xlsx")
    assert response.status_code == 200
    assert response.content[:2] == b"PK"

    from openpyxl import load_workbook

    workbook = load_workbook(BytesIO(response.content))
    assert set(workbook.sheetnames) == {"Participants", "Incidents"}
    sheet = workbook["Participants"]
    assert sheet["A1"].value == "exam_code"
    assert sheet.max_row == 2
