"""End-to-end smoke script against a live server (no TestClient).

Usage:
    python e2e_smoke.py http://127.0.0.1:8123
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123").rstrip("/")
API = f"{BASE}/api/v1"

_cookies: dict[str, str] = {}
_csrf = ""


def call(method: str, path: str, body=None, *, headers=None, token=None, expect=None):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if _cookies:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in _cookies.items()))
    if _csrf and method not in {"GET", "HEAD"}:
        req.add_header("X-CSRF-Token", _csrf)
    if token:
        req.add_header("X-Participant-Token", token)
    for key, value in (headers or {}).items():
        req.add_header(key, value)

    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode()
            for cookie in response.headers.get_all("Set-Cookie") or []:
                pair = cookie.split(";", 1)[0]
                if "=" in pair:
                    name, value = pair.split("=", 1)
                    _cookies[name.strip()] = value.strip()
            payload = json.loads(raw) if raw else None
            status = response.status
            issued = response.headers.get("X-Participant-Token")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        payload = json.loads(raw) if raw else None
        status = exc.code
        issued = exc.headers.get("X-Participant-Token")

    if expect is not None and status != expect:
        raise AssertionError(f"{method} {path} -> {status} (expected {expect}): {payload}")
    return status, payload, issued


def check(label: str, condition: bool, extra: str = "") -> None:
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {label}" + (f" — {extra}" if extra else ""))
    if not condition:
        raise SystemExit(1)


def main() -> None:
    global _csrf

    # Unique exam codes so the script can be re-run against the same database.
    run_id = str(int(time.time()))[-6:]
    EXAM_CODE = f"EXG-E2E-{run_id}"
    OTHER_CODE = f"EXG-E2E-{run_id}B"

    print(f"ExamGuard E2E smoke test -> {BASE}\n")

    # 1. Health and setup status
    status, health, _ = call("GET", "/meta", expect=200)
    check("API meta reachable", health["version"] == "1.3.0", health["version"])
    status, setup, _ = call("GET", "/setup/status", expect=200)
    print(f"      setup_required={setup['setup_required']}")

    # 2. First-run setup (or login when the database is already initialised)
    status, setup, _ = call("GET", "/setup/status", expect=200)
    if setup["setup_required"]:
        status, me, _ = call(
            "POST",
            "/setup",
            {
                "setup_secret": "e2e-setup",
                "email": "admin@example.com",
                "full_name": "Admin E2E",
                "password": "AdminRahasia123",
            },
            expect=201,
        )
        check("admin created", me["user"]["role"] == "ADMIN")
        check("session cookie httpOnly", "eg_session" in _cookies)
        status, setup_again, _ = call("GET", "/setup/status", expect=200)
        check("setup now disabled", setup_again["setup_required"] is False)
    else:
        status, me, _ = call(
            "POST",
            "/auth/login",
            {"email": "admin@example.com", "password": "AdminRahasia123"},
            expect=200,
        )
        check("existing admin login", me["user"]["role"] == "ADMIN")
    _csrf = me["csrf_token"]

    # 3. Create exam
    status, exam, _ = call(
        "POST",
        "/exams",
        {
            "name": "Ujian E2E",
            "exam_code": EXAM_CODE,
            "duration_minutes": 30,
            "status": "REGISTRATION_OPEN",
            "google_forms_url": "https://docs.google.com/forms/d/e/e2e/viewform",
        },
        expect=201,
    )
    check("exam created", exam["exam_code"] == EXAM_CODE)

    # 4. Roster via CSV import
    boundary = "----examguardboundary"
    csv_body = "full_name,npm,email\nAlek Nurhabib,2021001,alek@example.com\nSiti Aminah,2021002,\n"
    multipart = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="roster.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
        f"{csv_body}\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    req = urllib.request.Request(f"{API}/exams/{exam['id']}/roster/import", data=multipart, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("X-CSRF-Token", _csrf)
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in _cookies.items()))
    with urllib.request.urlopen(req, timeout=20) as response:
        imported = json.loads(response.read().decode())
    check("roster imported", imported["imported"] == 2, f"{imported}")

    # 5. Participant registration with a normalized variant
    status, participant, token = call(
        "POST",
        "/participant/register",
        {
            "exam_code": EXAM_CODE,
            "full_name": "  ALeK   NurHaBIb ",
            "npm": "9999999",
            "commitment_accepted": True,
        },
        expect=201,
    )
    check("canonical name returned", participant["participant"]["full_name"] == "Alek Nurhabib")
    check("participant token issued", bool(token))
    ps_id = participant["participant_session_id"]
    check("commitment stored", participant["commitment"]["accepted"] is True)

    # 6. Wrong name is rejected with the generic message
    status, err, _ = call(
        "POST",
        "/participant/register",
        {
            "exam_code": EXAM_CODE,
            "full_name": "Alek Nurhabip",
            "commitment_accepted": True,
        },
        expect=404,
    )
    check(
        "typo rejected generically",
        err["detail"] == "Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama.",
    )

    # 7. Commitment is mandatory
    status, err, _ = call(
        "POST",
        "/participant/register",
        {
            "exam_code": EXAM_CODE,
            "full_name": "Siti Aminah",
            "commitment_accepted": False,
        },
        expect=422,
    )
    check("commitment enforced server-side", "integritas" in err["detail"].lower())

    # 8. Start exam → server timer
    status, started, _ = call("POST", f"/exams/{exam['id']}/start", expect=200)
    check("exam live", started["status"] == "LIVE")
    check("deadline set", started["ends_at"] is not None)

    status, timer, _ = call("GET", f"/exams/{exam['id']}/timer", expect=200)
    check("timer counts down", 1700 < timer["remaining_seconds"] <= 1800, str(timer["remaining_seconds"]))

    # 9. Readiness gate
    status, err, _ = call(
        "POST",
        "/participant/monitoring/start",
        {"participant_session_id": ps_id},
        token=token,
        expect=409,
    )
    check("monitoring blocked before ready", "belum terverifikasi" in err["detail"])

    status, ready, _ = call(
        "POST",
        "/participant/ready",
        {"participant_session_id": ps_id},
        token=token,
        expect=200,
    )
    check("session READY", ready["status"] == "READY")

    status, monitoring, _ = call(
        "POST",
        "/participant/monitoring/start",
        {"participant_session_id": ps_id},
        token=token,
        expect=200,
    )
    check("session MONITORING", monitoring["status"] == "MONITORING")

    # 10. Event ingest → incident
    status, events, _ = call(
        "POST",
        f"/participant/events?participant_session_id={ps_id}",
        [
            {
                "client_event_id": "e2e-evt-1",
                "event_type": "TAB_SWITCH",
                "page_url": "https://docs.google.com/forms/d/e/e2e/viewform?token=SECRET",
                "metadata": {"host": "docs.google.com"},
            }
        ],
        token=token,
        expect=201,
    )
    check("event stored host-only", events[0]["page_host"] == "docs.google.com")
    check("full URL discarded", "SECRET" not in json.dumps(events))

    # 11. Duplicate event id is idempotent
    status, events2, _ = call(
        "POST",
        f"/participant/events?participant_session_id={ps_id}",
        [{"client_event_id": "e2e-evt-1", "event_type": "TAB_SWITCH"}],
        token=token,
        expect=201,
    )
    check("idempotent by client_event_id", events2[0]["id"] == events[0]["id"])

    status, incidents, _ = call("GET", f"/exams/{exam['id']}/incidents", expect=200)
    check("incident created", len(incidents) == 1 and incidents[0]["event_count"] == 1)

    # 12. Heartbeat and dashboard
    call("POST", "/participant/heartbeat", {"participant_session_id": ps_id}, token=token, expect=200)
    status, cards, _ = call("GET", f"/exams/{exam['id']}/monitor", expect=200)
    check("participant card online", cards[0]["online"] is True, cards[0]["connection_state"])
    check("incident counted on card", cards[0]["incident_count"] == 1)

    # 13. Incident review + audit
    status, reviewed, _ = call(
        "PATCH",
        f"/incidents/{incidents[0]['id']}",
        {"review_status": "REVIEWED", "notes": "Diverifikasi oleh proktor."},
        expect=200,
    )
    check("incident reviewed", reviewed["review_status"] == "REVIEWED")

    status, logs, _ = call("GET", "/audit-logs?action=incident.reviewed", expect=200)
    check("audit recorded", len(logs) == 1)

    # 14. Reports
    req = urllib.request.Request(f"{API}/exams/{exam['id']}/report.csv")
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in _cookies.items()))
    with urllib.request.urlopen(req, timeout=20) as response:
        csv_text = response.read().decode()
    check("CSV report contains participant", "Alek Nurhabib" in csv_text)
    check("CSV report has commitment column", "commitment_accepted" in csv_text)

    req = urllib.request.Request(f"{API}/exams/{exam['id']}/report.xlsx")
    req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in _cookies.items()))
    with urllib.request.urlopen(req, timeout=20) as response:
        xlsx_bytes = response.read()
    check("XLSX report is a zip", xlsx_bytes[:2] == b"PK", f"{len(xlsx_bytes)} bytes")

    # 15. CSRF enforcement
    saved = _csrf
    _csrf = ""
    status, _, _ = call("POST", "/exams", {"name": "Tanpa CSRF", "duration_minutes": 10})
    check("CSRF enforced", status == 403, f"status={status}")
    _csrf = saved

    # 16. Proctor scoping
    status, proctor, _ = call(
        "POST",
        "/admin/proctors",
        {
            "email": "proctor@example.com",
            "full_name": "Proktor E2E",
            "password": "ProktorRahasia123",
        },
        expect=201,
    )
    other = call(
        "POST",
        "/exams",
        {
            "name": "Ujian Lain",
            "exam_code": OTHER_CODE,
            "duration_minutes": 30,
            "status": "REGISTRATION_OPEN",
        },
        expect=201,
    )[1]
    call(
        "POST",
        f"/admin/exams/{exam['id']}/proctors",
        {"proctor_user_id": proctor["id"], "permissions": {"can_view_exam": True}},
        expect=201,
    )

    call("POST", "/auth/logout", expect=200)
    status, me2, _ = call(
        "POST", "/auth/login", {"email": "proctor@example.com", "password": "ProktorRahasia123"}, expect=200
    )
    _csrf = me2["csrf_token"]
    status, visible, _ = call("GET", "/exams", expect=200)
    check("proctor sees only assigned exam", len(visible) == 1 and visible[0]["id"] == exam["id"])
    status, _, _ = call("GET", f"/exams/{other['id']}", expect=403)
    check("proctor blocked on unassigned exam", status == 403)
    status, _, _ = call("POST", f"/exams/{exam['id']}/start", expect=403)
    check("proctor without can_start_exam blocked", status == 403)

    # 17. End exam
    call("POST", "/auth/logout", expect=200)
    status, me3, _ = call(
        "POST", "/auth/login", {"email": "admin@example.com", "password": "AdminRahasia123"}, expect=200
    )
    _csrf = me3["csrf_token"]
    status, ended, _ = call("POST", f"/exams/{exam['id']}/end", expect=200)
    check("exam completed", ended["status"] == "COMPLETED")

    status, cards, _ = call("GET", f"/exams/{exam['id']}/monitor", expect=200)
    check("participants completed", cards[0]["status"] == "COMPLETED")

    # 18. Registration closed after completion
    status, err, _ = call(
        "POST",
        "/participant/register",
        {
            "exam_code": EXAM_CODE,
            "full_name": "Siti Aminah",
            "commitment_accepted": True,
        },
        expect=409,
    )
    check("registration closed after exam", "berakhir" in err["detail"])

    print("\nAll end-to-end checks passed.")


if __name__ == "__main__":
    main()
