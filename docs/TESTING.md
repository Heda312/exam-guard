# Testing

## Backend

```bash
cd backend
python -m pytest -q
```

68 tests across seven modules:

| File | Coverage |
|---|---|
| `tests/test_names.py` | NFKC + casefold + whitespace removal, no fuzzy matching, NPM masking |
| `tests/test_auth.py` | first-run setup, single-use setup, login, CSRF, audit of failed logins |
| `tests/test_registration.py` | Exam-ID-only access, normalized-name match, typo rejection, NPM not a key, commitment enforcement, duplicate resume, ambiguous roster, rate limiting |
| `tests/test_exam_lifecycle.py` | exam-code generation, URL validation, server-authoritative deadline, start/end, invalid transitions, expiry worker, disconnect ≠ cheating |
| `tests/test_monitoring.py` | readiness gating, token enforcement, incident creation, idempotency, episode closing, review audit, connection badges |
| `tests/test_rbac.py` | proctor creation, admin-only actions, exam scoping, per-permission start/export denial, deactivation |
| `tests/test_roster_reports.py` | CSV preview/commit, duplicate detection, roster uniqueness, CSV/XLSX export |

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

Load `extension/` unpacked in Chrome and verify manually:

1. Register a participant, then click **Aktifkan pemantauan**.
2. Switch tabs → the popup badge increments and the dashboard card shows
   *Berpindah tab*.
3. Open a new tab, close it, blur the window → separate events appear.
4. Disable the network → the buffer grows; re-enable → events flush in batches.
5. Click **Hentikan pemantauan** → `CONNECTION_LOST` is recorded and no incident
   is created.

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
5. In the dashboard, **Mulai ujian** → participant page shows the countdown.
6. Complete readiness → **Aktifkan pemantauan** → switch tabs.
7. Dashboard shows an incident; **Tinjau** updates it and writes an audit entry.
8. **Akhiri ujian** → participant sees *Ujian selesai*.
9. Export CSV and XLSX from the exam detail page.

## What is intentionally *not* unit tested

- Google OIDC token verification against live Google JWKS (requires network and
  real credentials). The verifier is isolated in
  `services/identity.py::verify_google_id_token` and only invoked when
  `PARTICIPANT_IDENTITY_MODE=google`.
- Real Chrome extension APIs (MV3) — verified manually as described above.
