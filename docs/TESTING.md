# Testing

## Dependencies

```bash
cd backend
pip install -r requirements-dev.txt    # runtime + pytest, httpx, websockets
```

`requirements-dev.txt` is a superset of `requirements.txt` (it pulls it in with
`-r`). The production image installs runtime dependencies only.

## Backend

```bash
cd backend
python -m pytest -q
```

89 tests across eleven modules:

| File | Coverage |
|---|---|
| `tests/test_names.py` | NFKC + casefold + whitespace removal, no fuzzy matching, NPM masking |
| `tests/test_auth.py` | first-run setup, single-use setup, login, CSRF, audit of failed logins |
| `tests/test_registration.py` | Exam-ID-only access, normalized-name match, typo rejection, NPM not a key, commitment enforcement, duplicate resume, ambiguous roster, rate limiting |
| `tests/test_exam_lifecycle.py` | exam-code generation, URL validation, server-authoritative deadline, start/end, invalid transitions, expiry worker, disconnect ≠ cheating |
| `tests/test_monitoring.py` | readiness gating, token enforcement, incident creation, idempotency, episode closing, review audit, connection badges, combined monitor state, heartbeat timer payload, time-expired heartbeat |
| `tests/test_rbac.py` | proctor creation, admin-only actions, exam scoping, per-permission start/export denial, deactivation |
| `tests/test_roster_reports.py` | CSV preview/commit, duplicate detection, roster uniqueness, CSV/XLSX export |
| `tests/test_participant_payload.py` | NPM masking, no roster leakage, roster immutability |
| `tests/test_timestamps.py` | timezone-aware serialization (countdown regression guard) |
| `tests/test_bootstrap.py` | unattended first-boot admin creation, idempotency, weak/incomplete config, login |
| `tests/test_config.py` | cookie-domain and PostgreSQL URL normalization |

The suite runs against an isolated SQLite database created in a temp directory
(`tests/conftest.py`), drops all tables between tests, and never touches
development data.

Run a single area:

```bash
python -m pytest tests/test_registration.py -v
```

## Frontend

```bash
cd frontend
npm run typecheck     # tsc --noEmit
npm run build         # production bundle
```

## Extension

Load `extension/` unpacked in Chrome and verify:

1. Click the toolbar icon → the participant page (`/join`) opens. There is no popup.
2. Register with Exam ID + name + commitment → the waiting room appears in that same tab.
3. Proctor starts the exam → the extension navigates that same tab to the Google
   Forms URL, verifies the load, then marks the participant `MONITORING`.
4. Switch tabs for less than a second → the incident is uploaded immediately
   (violation events bypass the 30 s flush alarm).
5. Return to the exam tab → an in-page **Peringatan pelanggaran** overlay
   appears on the Google Form; the dashboard card updates in realtime.
6. Open a new tab / blur the window → events are captured; the badge shows the
   pending count.
7. Disable the network → the buffer grows; re-enable → events flush in batches.
8. Exam ends or time runs out → the exam tab shows the end/time-up overlay and
   the extension stops capture, flushes, and clears its alarms.

Automated equivalent (loads the unpacked extension in Chromium and asserts the
whole flow, 23 checks):

```bash
cd frontend
npm install --no-save puppeteer-core
CHROME_PATH="<path-to-chromium>" node scripts/extension_e2e.mjs http://127.0.0.1:5173
```

The script needs the backend and Vite running locally (`:8000` and `:5173`) and
uses the extension's default `apiBase` from the page origin.

- `CHROME_PATH` must point at Chromium / Chrome for Testing. Branded Chrome 137+
  ignores `--load-extension`; otherwise load the folder manually via
  `chrome://extensions`.
- `E2E_DB` (optional) points at the live SQLite file
  (`backend/data/<name>.db`). The script then rewrites `exam_sessions.ends_at`
  into the past to exercise the `TIME_EXPIRED` overlay. Without it the
  proctor-ended (`COMPLETED`) overlay is checked instead.
- `PYTHON` (optional) selects the interpreter used for that SQLite update
  (default `python`).

The check list covers: no popup, action click opens `/join`, tab id persistence,
bridge detection, stored session/token/apiBase, same-tab reuse, Google Forms
navigation, badge, backend `MONITORING`, the bundled `monitor/state` payload,
no premature overlay, realtime card rendering and update, fast tab-switch
incident capture, warning overlay on return, the end/time-up overlay, and the
extension stopping monitoring.

## Manual end-to-end smoke test

```bash
# terminal 1
cd backend && uvicorn app.main:app --reload --port 8000

# terminal 2
cd frontend && npm run dev
```

1. `/setup` → create admin with `SETUP_SECRET`.
2. Create an exam (`EXG-2026-001`, 90 min, `REGISTRATION_OPEN`, Google Forms URL).
3. Import a roster CSV containing `Alek Nurhabib`.
4. Open `/join`, enter `EXG-2026-001`, `aleknurhabib` → registers, shows
   canonical name `Alek Nurhabib`.
5. In the dashboard, **Mulai ujian** → the extension navigates the exam tab to the
   form URL and monitoring starts; the participant page shows the countdown.
6. Switch tabs in the participant browser → an incident appears in the dashboard.
7. **Tinjau** updates the incident and writes an audit entry.
8. **Akhiri ujian** → participant sees *Ujian selesai*.
9. Export CSV and XLSX from the exam detail page.

## What is intentionally *not* unit tested

- Google OIDC token verification against live Google JWKS (requires network and
  real credentials). The verifier is isolated in
  `services/identity.py::verify_google_id_token` and only invoked when
  `PARTICIPANT_IDENTITY_MODE=google`.
- `chrome.action.onClicked` itself cannot be dispatched by automation; the
  extension E2E exercises the same `openParticipantPage()` code path and asserts
  the resulting tab, persisted tab id, and navigation.
