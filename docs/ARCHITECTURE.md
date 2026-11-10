# Architecture

## 1. Components

```
┌───────────────────────┐        ┌────────────────────────┐
│  Participant browser  │        │  Proctor / Admin       │
│  /join (React)        │        │  dashboard (React)     │
│  + Chrome Extension   │        │                        │
└───────────┬───────────┘        └───────────┬────────────┘
            │ HTTPS + WS                     │ HTTPS + WS
            ▼                                ▼
        ┌──────────────────────────────────────────┐
        │              nginx (web image)           │
        │  static SPA · /api reverse proxy · /ws   │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │            FastAPI (api image)           │
        │  routers · RBAC deps · services          │
        │  WebSocket manager · expiry worker       │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │   PostgreSQL (prod) / SQLite (dev)       │
        └──────────────────────────────────────────┘
```

The API is a single process. Real-time fan-out uses an in-process
`ConnectionManager`, which is sufficient for the ~80 concurrent participants in
the initial deployment. Horizontal scaling would require a shared pub/sub broker
(see `DECISIONS.md`).

## 2. Data model

```
users ─┬─< auth_sessions
       ├─< exam_proctors >─ exams
       └─< audit_logs

exams ─┬─< exam_participants >─ participants
       ├─< exam_proctors
       └─< exam_sessions ─< participant_sessions ─┬─< monitoring_events
                                                  ├─< violation_incidents
                                                  └── access_token_hash
```

Key modelling decisions:

- **`participants` is roster-scoped identity**, not a login. It carries
  `full_name`, `normalized_name` (comparison key), optional `npm`, optional `email`.
- **`exam_participants`** joins a participant to one exam and duplicates
  `normalized_name` so roster uniqueness is checkable in one query and enforced
  per exam.
- **`exam_sessions`** holds the authoritative timer (`started_at`, `ends_at`).
- **`participant_sessions`** is one participant's attempt inside an exam session,
  holding lifecycle status, commitment evidence, heartbeat, and the hashed
  participant token.
- **`monitoring_events`** stores raw events with `page_host` only.
- **`violation_incidents`** stores correlated episodes derived from events.

## 3. State machines

### Exam (`app/states.py`)

```
DRAFT ──▶ SCHEDULED ──▶ REGISTRATION_OPEN ──▶ WAITING ──▶ STARTING ──▶ LIVE ──▶ COMPLETED
  │           │                 │                 │           │
  └───────────┴─────────────────┴─────────────────┴───────────┴──▶ CANCELLED
```

`LIVE` and `COMPLETED` are terminal for most edits: duration and form URL become
immutable once the exam starts.

### Participant session

```
REGISTERED ──▶ WAITING ──▶ INITIALIZING ──▶ READY ──▶ MONITORING
     │             │             │            │           │
     └─────────────┴─────────────┴────────────┴───────────┴──▶ CONNECTION_LOST
                                                                   │
                                                                   └──▶ MONITORING / READY

any non-terminal ──▶ TIME_EXPIRED | COMPLETED | CANCELLED
```

`CONNECTION_LOST` is *not* a violation. It only changes the connection state and
the dashboard badge.

## 4. Registration sequence

`POST /api/v1/participant/register`

1. (Optional) verify Google ID token when `PARTICIPANT_IDENTITY_MODE=google`.
2. Normalize and look up the exam by `exam_code`.
3. Check `registration_window_state()` (status + open/close timestamps).
4. `normalize_name(full_name)` → find roster rows for this exam with that key.
5. Require **exactly one** match. Zero or multiple → identical generic error, so
   the endpoint cannot be used to enumerate the roster.
6. Require `commitment_accepted === true` and a matching commitment version.
7. Store NPM as informational data only.
8. Resume the existing active participant session, or create a new one.
9. Issue an opaque participant token (only its SHA-256 hash is stored) and return
   the canonical roster name.

## 5. Server-authoritative timer

- `start_exam()` sets `started_at = now` and `ends_at = now + duration_minutes`
  exactly once.
- Clients never send a deadline; `ParticipantSessionOut.ends_at` is the only
  source of truth, and the frontend recomputes the countdown from
  `server_time` on every poll to correct for clock drift.
- `worker.sweep_once()` runs every `EXPIRY_SWEEP_SECONDS`, transitions expired
  exam sessions to `COMPLETED`, marks remaining participant sessions
  `TIME_EXPIRED`, and pushes `time_expired` over WebSocket.
- Because the deadline is persisted, disconnection has no effect on the timer.

## 6. Monitoring pipeline

```
extension service worker
   ├─ chrome.tabs.onActivated / onCreated / onRemoved / onUpdated
   ├─ chrome.windows.onFocusChanged
   ├─ buffer in chrome.storage.local (durable)
   └─ POST /participant/events (batch ≤ 50, idempotent by client_event_id)
                     │
                     ▼
          record_event()  ──▶ monitoring_events (host only)
                     │
                     └─ _correlate() ──▶ violation_incidents
                     │
                     └─ WebSocket broadcast to /ws/exam/{exam_session_id}
```

Correlation rules (`services/monitoring.py`):

- `FOCUS_LOST`, `WINDOW_MINIMIZED`, `TAB_SWITCH`, `NEW_TAB`, `TAB_CLOSED`,
  `NAVIGATION` can open an incident episode.
- `FOCUS_RESTORED` closes the open episode.
- Events within `INCIDENT_CORRELATION_MS` extend the current episode instead of
  opening a new one.
- `CONNECTION_LOST` never creates an incident.

## 7. Authorization

`app/deps.py` provides the whole enforcement surface:

| Dependency | Effect |
|---|---|
| `get_current_user` | resolves the session cookie → active user |
| `require_csrf` | double-submit CSRF check for all non-GET requests |
| `get_admin` | 403 unless `role == ADMIN` |
| `get_dashboard_user` | 403 unless `ADMIN` or `PROCTOR` |
| `require_exam_access(db, user, exam_id, permission)` | admin bypass; proctor must have an assignment row with the flag set |

Permission flags enforced server-side: `can_view_exam`, `can_view_participants`,
`can_start_exam`, `can_end_exam`, `can_review_incidents`, `can_export_report`.

Frontend menu hiding is cosmetic only — every route re-checks on the server.

## 8. Participant authentication

Participants are not dashboard users. After a successful roster match the API
returns `X-Participant-Token`, an opaque 32-byte URL-safe string. Only
`sha256(token)` is stored in `participant_sessions.access_token_hash`. Every
participant endpoint compares the supplied token in constant time and scopes the
operation to that single participant session.

## 9. Background worker

`app/worker.py` runs inside the API lifespan:

- expires finished exam sessions,
- marks silent `READY`/`MONITORING` sessions as `CONNECTION_LOST` when no live
  WebSocket is attached,
- never mutates `monitoring_events` or `audit_logs`.

## 10. Data minimisation

- Event rows store `page_host` only; `page_url` is intentionally `NULL`.
- Audit metadata never contains passwords or tokens.
- Login failures record the attempted email and reason, never the password.
- Reports expose roster identity, commitment evidence, incident counts and
  connection loss seconds — not browsing content.
