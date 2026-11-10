"""WebSocket smoke test against a live server.

Usage:
    python ws_smoke.py http://127.0.0.1:8123

Verifies:
  - proctor socket connects with the session cookie and exam assignment,
  - participant socket connects with the participant token,
  - an event submitted over HTTP is broadcast to the proctor socket.
"""
from __future__ import annotations

import asyncio
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123").rstrip("/")
API = f"{BASE}/api/v1"
WS_BASE = BASE.replace("http://", "ws://").replace("https://", "wss://")

_cookies: dict[str, str] = {}
_csrf = ""


def call(method, path, body=None, *, token=None, expect=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if _cookies:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in _cookies.items()))
    if _csrf and method not in {"GET", "HEAD"}:
        req.add_header("X-CSRF-Token", _csrf)
    if token:
        req.add_header("X-Participant-Token", token)
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


def check(label, condition, extra=""):
    print(f"[{'PASS' if condition else 'FAIL'}] {label}" + (f" — {extra}" if extra else ""))
    if not condition:
        raise SystemExit(1)


async def main() -> None:
    global _csrf
    try:
        import websockets
    except ImportError:
        print("SKIP: paket 'websockets' tidak terpasang (pip install websockets)")
        return

    print(f"ExamGuard WebSocket smoke test -> {BASE}\n")

    # Prepare state: admin, exam, roster, participant, live exam, monitoring.
    status, setup, _ = call("GET", "/setup/status", expect=200)
    if setup["setup_required"]:
        _, me, _ = call(
            "POST",
            "/setup",
            {
                "setup_secret": "e2e-setup",
                "email": "admin@example.com",
                "full_name": "Admin WS",
                "password": "AdminRahasia123",
            },
            expect=201,
        )
    else:
        _, me, _ = call(
            "POST", "/auth/login", {"email": "admin@example.com", "password": "AdminRahasia123"}, expect=200
        )
    _csrf = me["csrf_token"]

    _, exam, _ = call(
        "POST",
        "/exams",
        {
            "name": "Ujian WS",
            "exam_code": "EXG-WS-001",
            "duration_minutes": 20,
            "status": "REGISTRATION_OPEN",
            "google_forms_url": "https://docs.google.com/forms/d/e/ws/viewform",
        },
        expect=201,
    )
    call("POST", f"/exams/{exam['id']}/roster", {"full_name": "Budi Santoso"}, expect=201)
    _, participant, ptoken = call(
        "POST",
        "/participant/register",
        {"exam_code": "EXG-WS-001", "full_name": "Budi Santoso", "commitment_accepted": True},
        expect=201,
    )
    ps_id = participant["participant_session_id"]
    _, started, _ = call("POST", f"/exams/{exam['id']}/start", expect=200)
    exam_session_id = started["exam_session_id"]
    check("exam session id exposed", bool(exam_session_id), exam_session_id or "")

    call("POST", "/participant/ready", {"participant_session_id": ps_id}, token=ptoken, expect=200)
    call("POST", "/participant/monitoring/start", {"participant_session_id": ps_id}, token=ptoken, expect=200)

    cookie_header = "; ".join(f"{k}={v}" for k, v in _cookies.items())

    # Proctor socket (session cookie) + participant socket (token).
    async with websockets.connect(
        f"{WS_BASE}/ws/exam/{exam_session_id}",
        additional_headers={"Cookie": cookie_header},
    ) as proctor_socket:
        hello = json.loads(await asyncio.wait_for(proctor_socket.recv(), timeout=10))
        check("proctor socket connected", hello["event"] == "connected")
        check("proctor hello has deadline", hello["data"]["ends_at"] is not None)

        async with websockets.connect(
            f"{WS_BASE}/ws/participant/{ps_id}?token={ptoken}"
        ) as participant_socket:
            phello = json.loads(await asyncio.wait_for(participant_socket.recv(), timeout=10))
            check("participant socket connected", phello["event"] == "connected")

            call(
                "POST",
                f"/participant/events?participant_session_id={ps_id}",
                [{"client_event_id": "ws-evt-1", "event_type": "NEW_TAB"}],
                token=ptoken,
                expect=201,
            )

            received = []
            deadline = asyncio.get_event_loop().time() + 8
            while asyncio.get_event_loop().time() < deadline:
                try:
                    frame = json.loads(await asyncio.wait_for(proctor_socket.recv(), timeout=3))
                    received.append(frame["event"])
                    if "incident_created" in received:
                        break
                except asyncio.TimeoutError:
                    break

            check("monitoring_event broadcast", "monitoring_event" in received, str(received))
            check("incident_created broadcast", "incident_created" in received, str(received))

    # Unauthorized sockets must be rejected.
    try:
        async with websockets.connect(
            f"{WS_BASE}/ws/exam/{exam_session_id}", additional_headers={"Cookie": "eg_session=palsu"}
        ) as bad:
            await asyncio.wait_for(bad.recv(), timeout=5)
        check("invalid proctor socket rejected", False)
    except Exception as exc:  # noqa: BLE001
        check("invalid proctor socket rejected", True, type(exc).__name__)

    try:
        async with websockets.connect(f"{WS_BASE}/ws/participant/{ps_id}?token=salah") as bad:
            await asyncio.wait_for(bad.recv(), timeout=5)
        check("invalid participant socket rejected", False)
    except Exception as exc:  # noqa: BLE001
        check("invalid participant socket rejected", True, type(exc).__name__)

    print("\nAll WebSocket checks passed.")


if __name__ == "__main__":
    asyncio.run(main())
