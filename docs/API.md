# API Reference — v1.3.0

Base URL: `/api/v1` · OpenAPI: `/api/docs` · Health: `/health`

## Authentication model

| Caller | Credential | Notes |
|---|---|---|
| Admin / Proctor | `eg_session` HttpOnly cookie + `X-CSRF-Token` header | CSRF required for `POST`/`PATCH`/`DELETE` |
| Participant | `X-Participant-Token` header | Scoped to one participant session |

Error shape: `{"detail": "pesan"}` or `{"detail": {"field": "...", "message": "..."}}`.

---

## Setup & auth

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/setup/status` | public | `{setup_required, setup_secret_configured}` |
| POST | `/setup` | `SETUP_SECRET` | Create the first admin (`username` + password); permanently disables setup |
| POST | `/auth/login` | public (rate limited) | Body `{username, password}`; sets session + CSRF cookies |
| GET | `/auth/me` | session | Current user + permissions map |
| POST | `/auth/logout` | session | Revokes the session |
| POST | `/auth/change-password` | session + CSRF | Rotate own password |

Staff accounts (admin and proctor) authenticate with a **username**, not an
email. `email` still exists on the user record as optional contact information.

### Permission payload

```json
{
  "role": "ADMIN",
  "is_admin": true,
  "exams": [],
  "global": {
    "manage_users": true, "manage_exams": true, "manage_roster": true,
    "review_incidents": true, "export_report": true,
    "view_audit": true, "manage_settings": true
  }
}
```

For a proctor, `exams` lists `{exam_id, permissions:{can_view_exam, …}}` and the
`global` flags are derived from those assignments.

---

## Exams

| Method | Path | Auth | Permission |
|---|---|---|---|
| GET | `/exams` | dashboard | visible exams only |
| POST | `/exams` | admin | — |
| GET | `/exams/{exam_id}` | dashboard | `can_view_exam` |
| PATCH | `/exams/{exam_id}` | admin | — |
| DELETE | `/exams/{exam_id}` | admin | — (cascades roster, sessions, incidents, assignments; rejected while `LIVE`) |
| POST | `/exams/{exam_id}/status` | dashboard | `can_start_exam` / `can_end_exam` for LIVE/COMPLETED |
| POST | `/exams/{exam_id}/start` | dashboard | `can_start_exam` |
| POST | `/exams/{exam_id}/end` | dashboard | `can_end_exam` |
| GET | `/exams/{exam_id}/timer` | dashboard | `can_view_exam` |
| GET | `/exams/{exam_id}/monitor` | dashboard | `can_view_participants` |
| GET | `/exams/{exam_id}/incidents` | dashboard | `can_review_incidents` |
| GET | `/exams/{exam_id}/report.csv` | dashboard | `can_export_report` |
| GET | `/exams/{exam_id}/report.xlsx` | dashboard | `can_export_report` |

`POST /exams` body:

```json
{
  "name": "Ujian Tengah Semester",
  "exam_code": "EXG-2026-001",       // optional, auto-generated when omitted
  "description": "…",
  "google_forms_url": "https://docs.google.com/forms/d/e/…/viewform",
  "duration_minutes": 90,
  "scheduled_at": "2026-03-01T08:00:00Z",
  "registration_opens_at": null,
  "registration_closes_at": null,
  "status": "REGISTRATION_OPEN"
}
```

`google_forms_url` must be HTTPS and on an allow-listed host
(`ALLOWED_EXAM_URL_HOSTS`). `start` requires it to be set.

---

## Roster

| Method | Path | Auth | Permission |
|---|---|---|---|
| GET | `/exams/{exam_id}/roster` | dashboard | `can_view_participants` |
| POST | `/exams/{exam_id}/roster` | admin | roster unlocked |
| PATCH | `/exams/{exam_id}/roster/{entry_id}` | admin | roster unlocked |
| DELETE | `/exams/{exam_id}/roster/{entry_id}` | admin | roster unlocked |
| POST | `/exams/{exam_id}/roster/import/preview` | admin | multipart `file` |
| POST | `/exams/{exam_id}/roster/import` | admin | multipart `file` |
| GET | `/exams/{exam_id}/roster/import/errors` | admin | CSV template |

CSV columns: `full_name` (required), `npm`, `email`, `group_name` (optional).
Duplicate normalized names are rejected per exam; duplicate NPMs are allowed.

Preview row statuses: `ok`, `duplicate_in_file`, `duplicate_in_roster`, `invalid`.

---

## Proctor administration

| Method | Path | Auth |
|---|---|---|
| GET | `/admin/proctors` | admin |
| POST | `/admin/proctors` | admin |
| PATCH | `/admin/proctors/{proctor_id}` | admin |
| DELETE | `/admin/proctors/{proctor_id}` | admin (hard delete, also removes exam assignments) |
| GET | `/admin/exams/{exam_id}/proctors` | admin |
| POST | `/admin/exams/{exam_id}/proctors` | admin |
| PATCH | `/admin/exams/{exam_id}/proctors/{assignment_id}` | admin |
| DELETE | `/admin/exams/{exam_id}/proctors/{assignment_id}` | admin |

---

## Monitoring

| Method | Path | Auth | Permission |
|---|---|---|---|
| GET | `/dashboard/overview` | dashboard | scoped to visible exams |
| GET | `/participant-sessions/{id}` | dashboard | `can_view_participants` |
| PATCH | `/incidents/{incident_id}` | dashboard | `can_review_incidents` |
| GET | `/audit-logs` | admin | — |

Incident review body:

```json
{ "review_status": "REVIEWED", "notes": "Peserta menjawab telepon." }
```

`review_status`: `UNREVIEWED` | `REVIEWED` | `FLAGGED_FOR_FOLLOWUP`.

---

## Participant endpoints (public + token scoped)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/participant/config` | public | identity mode, commitment text, heartbeat interval |
| GET | `/participant/exam/{exam_code}/public` | public | exam name/status/registration window — no roster data |
| POST | `/participant/register` | public (rate limited) | Exam ID + name + commitment |
| POST | `/participant/session` | participant token | Resume / reconnect |
| GET | `/participant/session/{id}` | participant token | Read session |
| POST | `/participant/heartbeat` | participant token | Heartbeat (also used to resume after loss) |
| POST | `/participant/ready` | participant token | Exam page verified |
| POST | `/participant/monitoring/start` | participant token | READY → MONITORING |
| POST | `/participant/disconnect` | participant token | Mark connection lost |
| POST | `/participant/events?participant_session_id=…` | participant token | Batch event ingest (≤50) |

Register request:

```json
{
  "exam_code": "EXG-2026-001",
  "full_name": "Alek Nurhabib",
  "npm": "2021001",
  "commitment_accepted": true,
  "commitment_version": "exam-integrity-v1",
  "google_id_token": null
}
```

Success `201` returns the participant session and sets the
`X-Participant-Token` response header.

Failure messages are deliberately generic for identity problems:

| Status | Detail |
|---|---|
| 404 | `Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama.` |
| 409 | `Pendaftaran untuk ujian ini belum dibuka.` / `Ujian sudah dimulai.` / `Ujian telah berakhir.` |
| 422 | `Pernyataan integritas wajib disetujui.` |
| 429 | `Terlalu banyak percobaan pendaftaran. Coba lagi nanti.` |

Event payload:

```json
[
  {
    "client_event_id": "evt-1710000000-ab12cd34",
    "event_type": "TAB_SWITCH",
    "client_timestamp": "2026-03-01T08:15:04Z",
    "tab_id": 12,
    "window_id": 1,
    "page_url": "https://docs.google.com/forms/d/e/…/viewform?usp=sf_link",
    "metadata": { "host": "docs.google.com" },
    "extension_version": "1.3.0"
  }
]
```

The server stores only the host; the full URL is discarded.

---

## WebSocket

| Endpoint | Auth | Purpose |
|---|---|---|
| `/ws/exam/{exam_session_id}` | session cookie + exam assignment | Proctor dashboard feed |
| `/ws/participant/{participant_session_id}?token=…` | participant token | Participant feed |

Server → client envelopes:

```json
{ "event": "monitoring_event", "server_time": "…", "data": { … } }
```

Events: `connected`, `exam_started`, `exam_ended`, `time_expired`,
`monitoring_event`, `incident_created`, `incident_reviewed`,
`participant_ready`, `participant_monitoring_started`,
`participant_connection_lost`, `pong`.

Client may send the literal text `ping` to receive `pong`.
