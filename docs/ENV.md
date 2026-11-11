# Environment Variables

All variables are read by `backend/app/config.py` (pydantic-settings) from the
process environment or a `.env` file. Booleans accept `true`/`false`/`1`/`0`.

## Dependency files

| File | Scope |
|---|---|
| `backend/requirements.txt` | API runtime |
| `backend/requirements-dev.txt` | Runtime + pytest, httpx, websockets (superset, uses `-r`) |
| `frontend/package.json` | Dashboard & participant page |
| `extension/` | No dependencies, no build step |

## Core

| Variable | Default | Description |
|---|---|---|
| `APP_NAME` | `ExamGuard` | Displayed in OpenAPI and `/health` |
| `APP_ENV` | `development` | `development` \| `production` \| `test` |
| `PUBLIC_BASE_URL` | `https://exam.heda.my.id` | Public origin (links, docs) |
| `API_PREFIX` | `/api/v1` | Router mount prefix |

## Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./data/examguard.db` | `postgres://` and `postgresql://` are auto-normalized to `postgresql+psycopg://`. In Compose it defaults to the `POSTGRES_*` values; set it explicitly (URL-encoded) when the password contains `@`, `/`, `?` or `%` |
| `AUTO_CREATE_TABLES` | `true` | Create tables at startup. The production container sets `false` and runs Alembic instead |
| `RUN_MIGRATIONS` | `true` | Docker only: the entrypoint runs `alembic upgrade head` before starting |

## Secrets

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | `change-me-in-production` | Server-side secret. **Must** be replaced in production |
| `SETUP_SECRET` | *(empty)* | Required by the browser setup wizard. Empty disables it |
| `SETUP_DISABLED` | `false` | Hard-disable first-run setup |

## Unattended administrator bootstrap

Used by the Docker entrypoint so no browser step is needed.

| Variable | Default | Description |
|---|---|---|
| `BOOTSTRAP_ADMIN_ENABLED` | `true` | Docker only: run the bootstrap step on start |
| `BOOTSTRAP_ADMIN_EMAIL` | *(empty)* | Initial admin email. With the password set, the account is created on first boot |
| `BOOTSTRAP_ADMIN_PASSWORD` | *(empty)* | Initial admin password (≥10 chars, letters + digits). The admin must change it on first login |
| `BOOTSTRAP_ADMIN_NAME` | `Administrator` | Display name for the initial admin |

The step is idempotent: it does nothing once any administrator exists, and it
marks first-run setup as completed.

## Sessions

| Variable | Default | Description |
|---|---|---|
| `SESSION_COOKIE_NAME` | `eg_session` | HttpOnly session cookie |
| `CSRF_COOKIE_NAME` | `eg_csrf` | JS-readable CSRF cookie (double submit) |
| `CSRF_HEADER_NAME` | `X-CSRF-Token` | Header compared against the CSRF cookie |
| `SESSION_TTL_MINUTES` | `720` | Session lifetime |
| `COOKIE_SECURE` | `true` | Set `false` only for plain HTTP (`http://localhost`, LAN) |
| `COOKIE_DOMAIN` | *(empty)* | Optional cookie domain |
| `COOKIE_SAMESITE` | `lax` | `lax` \| `strict` \| `none` |

## Password policy

| Variable | Default | Description |
|---|---|---|
| `PASSWORD_MIN_LENGTH` | `10` | Minimum length; must also contain letters and digits |

## Participant identity

| Variable | Default | Description |
|---|---|---|
| `PARTICIPANT_IDENTITY_MODE` | `none` | `none` = Exam ID + normalized name only; `google` = also verify a Google ID token |
| `GOOGLE_CLIENT_ID` | *(empty)* | OAuth client ID used as the token audience when mode is `google` |
| `GOOGLE_ALLOWED_DOMAINS` | *(empty)* | Comma-separated email domains; empty allows any |

See `docs/DECISIONS.md` (D-1) for why the default is `none`.

## Exams

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_EXAM_DURATION_MINUTES` | `90` | Default when creating an exam |
| `COMMITMENT_VERSION` | `exam-integrity-v1` | Version stored with each accepted commitment |
| `ALLOWED_EXAM_URL_HOSTS` | `docs.google.com,forms.gle,forms.google.com` | Allow-list for the exam form URL |

## Monitoring

| Variable | Default | Description |
|---|---|---|
| `HEARTBEAT_INTERVAL_SECONDS` | `10` | Client heartbeat cadence |
| `HEARTBEAT_TIMEOUT_SECONDS` | `45` | Silence before a session becomes `CONNECTION_LOST` |
| `INCIDENT_CORRELATION_MS` | `400` | Episode grouping window |
| `EXPIRY_SWEEP_SECONDS` | `5` | Maintenance worker interval |

## Rate limiting

| Variable | Default | Description |
|---|---|---|
| `LOGIN_RATE_LIMIT_PER_MINUTE` | `10` | Per IP+email |
| `REGISTER_RATE_LIMIT_PER_MINUTE` | `20` | Per IP |

## CORS

| Variable | Default | Description |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,https://exam.heda.my.id` | Comma-separated allowed origins (credentials enabled) |

## Docker Compose only

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_DB` | `examguard` | Database name |
| `POSTGRES_USER` | `examguard` | Database user |
| `POSTGRES_PASSWORD` | *(required)* | Database password |
| `WEB_PORT` | `9200` | Host port published by nginx. Point Cloudflare Tunnel at `http://127.0.0.1:9200` |
| `API_PORT` | `8000` | In-container API port. The nginx template picks it up at start |
| `COOKIE_SECURE` | `true` | Set `false` when serving the stack over plain HTTP |

## Frontend dev server only

| Variable | Default | Description |
|---|---|---|
| `VITE_API_TARGET` | `http://127.0.0.1:8000` | Upstream for the Vite `/api` and `/ws` proxy. In `docker-compose.dev.yml` it is set to `http://api:8000` |
