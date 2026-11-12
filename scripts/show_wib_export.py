"""Print a real CSV/XLSX export so the WIB formatting can be inspected.

Run from backend/:  python ../scripts/show_wib_export.py
"""
from __future__ import annotations

import sys
import tempfile
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import os  # noqa: E402

os.environ["APP_ENV"] = "test"
_tmp = Path(tempfile.mkdtemp(prefix="wib-export-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_tmp / 'wib.db').as_posix()}"
os.environ["SECRET_KEY"] = "wib-test"
os.environ["SETUP_SECRET"] = "wib-setup"
os.environ["COOKIE_SECURE"] = "false"
os.environ["AUTO_CREATE_TABLES"] = "true"
os.environ["PARTICIPANT_IDENTITY_MODE"] = "none"

from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

from app.main import create_app  # noqa: E402


def main() -> int:
    app = create_app()
    with TestClient(app) as client:
        client.post(
            "/api/v1/setup",
            json={
                "setup_secret": "wib-setup",
                "username": "admin",
                "full_name": "Admin",
                "password": "AdminRahasia123",
            },
        )
        client.headers.update({"X-CSRF-Token": client.cookies.get("eg_csrf") or ""})

        exam = client.post(
            "/api/v1/exams",
            json={
                "name": "Ujian WIB",
                "duration_minutes": 30,
                "status": "REGISTRATION_OPEN",
                "google_forms_url": "https://docs.google.com/forms/d/e/wib/viewform",
            },
        ).json()
        client.post(f"/api/v1/exams/{exam['id']}/roster", json={"full_name": "Alek Nurhabib"})
        client.post(
            "/api/v1/participant/register",
            json={
                "exam_code": exam["exam_code"],
                "full_name": "Alek Nurhabib",
                "commitment_accepted": True,
            },
        )
        client.post(f"/api/v1/exams/{exam['id']}/start")

        csv_text = client.get(f"/api/v1/exams/{exam['id']}/report.csv").content.decode("utf-8")
        print("=" * 78)
        print("CSV")
        print("=" * 78)
        for line in csv_text.splitlines()[:4]:
            print(line)
        print()

        xlsx = client.get(f"/api/v1/exams/{exam['id']}/report.xlsx").content
        workbook = load_workbook(BytesIO(xlsx))
        sheet = workbook["Participants"]
        print("=" * 78)
        print("XLSX — Participants")
        print("=" * 78)
        print(f"A1 (note) : {sheet['A1'].value}")
        headers = [cell.value for cell in sheet[2]]
        values = [cell.value for cell in sheet[3]]
        for header, value in zip(headers, values):
            if header and header.endswith("_at"):
                print(f"  {header:24} = {value!r}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
