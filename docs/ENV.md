# Environment Variables

All variables are read by `backend/app/config.py` (pydantic-settings) from the
process environment or a `.env` file. Booleans accept `true`/`false`/`1`/`0`.

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
| `DATABASE_URL` | `sqlite:///./data/examguard.db` | `postgres://` and `postgresql://` are auto-normalized to `postgresql+psycopg://` |
| `AUTO_CREATE_TABLES` | `true` | Create tables at startup. Set `false` in production and use Alembic |

## Secrets

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | `change-me-in-production` | Server-side secret. **Must** be replaced in production |
| `SETUP_SECRET` | *(empty)* | Required by `/setup`. Empty disables the setup page |
| `SETUP_DISABLED` | `false` | Hard-disable first-run setup |

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
| `HTTP_PORT` | `8080` | Host port mapped to nginx |
| `CORS_ORIGINS` | `https://exam.heda.my.id` | Public origin(s) |
| `COOKIE_SECURE` | `true` | Set `false` when serving the stack over plain HTTP |

## Frontend dev server only

| Variable | Default | Description |
|---|---|---|
| `VITE_API_TARGET` | `http://127.0.0.1:8000` | Upstream for the Vite `/api` and `/ws` proxy. In `docker-compose.dev.yml` it is set to `http://api:8000` |
