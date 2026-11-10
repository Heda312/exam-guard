# Decisions & Deviations from Spec v1.3

This file records where the implementation deliberately differs from
`ExamGuard_Feature_Specification_v1.3.md`, and why. Each item states the spec
requirement, the implemented behaviour, and how to restore strict compliance.

---

## D-1. Participant Google authentication is optional (default: off)

**Spec §5.2 / §6.5 step 1:** "Google login is **required** before participant
registration in ExamGuard", and registration validation step 1 is
"Validate the Google-authenticated identity".

**Decision (per project owner instruction):** Google sign-in for participants is
outside the scope of this system. It is the institution's own choice and is not
part of ExamGuard's access rules. The participant roster match remains the real
identity check.

**Implemented:**

- `PARTICIPANT_IDENTITY_MODE` setting, default `none`.
- `none` → `POST /participant/register` validates **Exam ID + normalized name +
  commitment** only. No token, no Google account.
- `google` → the backend additionally verifies a Google OIDC ID token
  (signature against Google JWKS, `aud` = `GOOGLE_CLIENT_ID`, `iss`, `exp`,
  `email_verified`, optional domain allow-list) via
  `services/identity.py::verify_google_id_token`.

**Why this is safe:** the Exam ID is explicitly *not* a credential in v1.3
(§6.2). Access is granted only when the submitted name normalizes to exactly one
roster entry for that exam, which is the same check the spec uses to identify the
participant. Identity binding to a Google account would add attribution, not
authorization. The commitment checkbox and all monitoring/audit controls are
unchanged.

**To restore strict spec compliance:** set

```env
PARTICIPANT_IDENTITY_MODE=google
GOOGLE_CLIENT_ID=<your-oauth-client-id>
GOOGLE_ALLOWED_DOMAINS=your-institution.ac.id   # optional
```

No code changes are required; the frontend already surfaces
`google_auth_required` from `GET /participant/config` and the backend rejects
registration without a valid ID token in that mode.

---

## D-2. Participant sessions use an opaque token, not a full login

**Spec:** participants are not dashboard users and must not receive dashboard
access (§3.1).

**Implemented:** after a successful roster match the API issues a 32-byte
URL-safe opaque token, returned in the `X-Participant-Token` response header.
Only `sha256(token)` is persisted (`participant_sessions.access_token_hash`).
The token is scoped to a single participant session and is compared in constant
time on every participant request.

**Consequence:** the token is rotated on every successful registration call, and
a browser that clears `localStorage` must re-register (which resumes the same
session because the roster match succeeds again).

---

## D-3. `READY` is a persisted state, `MONITORING` requires it

**Spec §11.2:** monitoring must not start before the exam tab is verified.

**Implemented:** `INITIALIZING → READY` is triggered by
`POST /participant/ready` (the web page/extension confirms the form loaded), and
`READY → MONITORING` by `POST /participant/monitoring/start`. The event ingest
endpoint returns `409` unless the session is in `MONITORING`.

---

## D-4. Incident correlation is time-windowed, not per-event

**Spec §15** describes incidents as episodes rather than a 1:1 mapping with raw
events.

**Implemented:** `INCIDENT_CORRELATION_MS` (default 400 ms) groups bursts into a
single episode; `FOCUS_RESTORED` closes the open episode; `CONNECTION_LOST` never
creates an incident. Review status is `UNREVIEWED` on creation.

---

## D-5. Only the page host is persisted

**Spec §21** requires data minimisation and forbids collecting full browsing
history.

**Implemented:** `services/monitoring.py::sanitize_host()` extracts the hostname;
`monitoring_events.page_url` is always `NULL`. Extension metadata may include
`host` but never query strings.

---

## D-6. Rate limiting is in-process

**Spec §6.2** requires throttling on registration, and §5.1 on login.

**Implemented:** `app/ratelimit.py` sliding-window limiter plus nginx
`limit_req` zones for `/api/v1/auth/login` and `/api/v1/participant/register`.

**Limitation:** the Python limiter is per-process. With more than one API
replica, move it to Redis (or rely solely on the nginx layer).

---

## D-7. WebSocket fan-out is in-process

`app/ws.py::ConnectionManager` keeps sockets in memory. This matches the single
container deployment (~80 concurrent participants). Multi-replica deployments
need a shared broker (Redis pub/sub) behind the same `envelope()` contract.

---

## D-8. `SCHEDULED` is also registration-eligible

**Spec §6.2** requires a "registration-allowed state". The implementation treats
`SCHEDULED`, `REGISTRATION_OPEN` and `WAITING` as eligible (subject to the
open/close timestamps), because a proctor may schedule an exam and immediately
collect registrations. `DRAFT`, `STARTING`, `LIVE`, `COMPLETED` and `CANCELLED`
are always refused.

To restrict strictly to `REGISTRATION_OPEN`, edit
`services/exams.py::registration_window_state()`.

---

## D-9. `AUTO_CREATE_TABLES` defaults to true only in development

Production uses `alembic upgrade head` with `AUTO_CREATE_TABLES=false`, so schema
changes are explicit and reviewable.

---

## D-10. Duplicate roster names are rejected at write time *and* at registration

**Spec §6.5 step 6** requires rejecting ambiguous roster matches at registration.

**Implemented:** both. `services/roster.py` refuses to create a roster entry whose
normalized name already exists for that exam (409), and registration re-checks
that exactly one match exists (defence against data imported by other means).
A test (`test_ambiguous_roster_is_rejected`) inserts a duplicate directly into the
DB to prove the registration path alone is sufficient.
