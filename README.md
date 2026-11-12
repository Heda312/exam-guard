# ExamGuard

Web-based examination session & browser activity monitoring.

**Backend** FastAPI + SQLAlchemy 2.0 · **Frontend** React + TypeScript + Vite ·
**Extension** Chrome MV3 · **Database** SQLite (dev) / PostgreSQL (prod)

Reference specification: `ExamGuard_Feature_Specification_v1.3.md`.

---

## Table of contents

- [What it does](#what-it-does)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Quick start — local (SQLite)](#quick-start--local-sqlite)
- [Quick start — Docker](#quick-start--docker)
- [Using the extension](#using-the-extension)
- [Configuration](#configuration)
- [Tests](#tests)
- [Core behaviour](#core-behaviour)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)

---

## What it does

| Actor | Capability |
|---|---|
| **Admin** | First-run setup, proctor accounts, exams, rosters, proctors, reports, audit log |
| **Proctor** | Monitor assigned exams only, review incidents, export reports (per permission) |
| **Participant** | Join with **Exam ID + full name**, accept the integrity commitment, take the exam, browser activity monitored |

Access rules (spec v1.3):

- **Exam ID only** — no join PIN, token, or invitation code exists anywhere in the schema.
- **Identity = Exam ID + normalized name** (NFKC → casefold → whitespace removed, exact match, no fuzzy matching).
- **NPM is informational only** — never used to accept or reject a registration.
- **Server-authoritative timer** — the deadline is persisted and keeps running while a participant is disconnected.
- **Disconnection ≠ cheating** — `CONNECTION_LOST` never creates an incident.

---

## Repository layout

```
exam-guard/
├── backend/                  FastAPI service
│   ├── app/
│   │   ├── api/              auth, exams, admin_users, monitoring, participant
│   │   ├── services/         exams, roster, participants, monitoring, reports, identity
│   │   ├── models.py         SQLAlchemy ORM (SQLite + PostgreSQL portable)
│   │   ├── states.py         exam & participant state machines
│   │   ├── worker.py         expiry + heartbeat sweeper
│   │   └── main.py           application factory
│   ├── alembic/              migrations
│   ├── tests/                pytest suite (85 tests)
│   ├── requirements.txt      runtime dependencies
│   ├── requirements-dev.txt  runtime + pytest/httpx/websockets
│   ├── e2e_smoke.py          live API smoke test (36 checks)
│   └── ws_smoke.py           live WebSocket smoke test
├── frontend/                 React dashboard + participant flow
│   ├── package.json          frontend dependencies
│   └── scripts/              ui_shots.mjs, extension_e2e.mjs
├── extension/                Chrome MV3 participant extension (no dependencies)
├── deploy/                   nginx config + proxy includes
├── docs/                     architecture, API, decisions, runbooks, screenshots
├── Dockerfile                backend image
├── web.Dockerfile            frontend build + nginx image
├── docker-compose.yml        production profile (PostgreSQL + API + nginx)
└── docker-compose.dev.yml    development profile (hot reload + SQLite)
```

### Where the dependency files live

This is a polyglot repository, so dependencies sit next to the component that
uses them rather than in the repository root:

| File | Component | Install |
|---|---|---|
| `backend/requirements.txt` | API runtime | `pip install -r requirements.txt` |
| `backend/requirements-dev.txt` | API + tests + smoke scripts | `pip install -r requirements-dev.txt` |
| `frontend/package.json` | Dashboard & participant page | `npm install` |
| — | Extension | none (plain MV3, no build step) |

`requirements-dev.txt` includes `requirements.txt` via `-r`, so it is a superset.

---

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| Python | 3.11+ | Backend (local) |
| Node.js | 20+ | Frontend (local) |
| Docker + Compose v2 | 24+ | Docker profiles |
| Chrome / Chromium | 114+ | Extension |

> Branded **Chrome 137+ ignores `--load-extension`**. Loading the folder manually
> via `chrome://extensions` still works. For automated tests use Chrome for
> Testing or Chromium.

---

## Quick start — local (SQLite)

Runs entirely on your machine: no Docker, no PostgreSQL.

### 1. Backend

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# Runtime only (just to run the API):
pip install -r requirements.txt

# Runtime + tests + smoke scripts (recommended for development):
pip install -r requirements-dev.txt
```

Create the environment file:

```bash
# Windows
copy ..\.env.local.example .env
# macOS / Linux
cp ../.env.local.example .env
```

The local defaults are ready to use: SQLite at `./data/examguard.db`,
`COOKIE_SECURE=false`, `AUTO_CREATE_TABLES=true`, bootstrap disabled, and
`SETUP_SECRET=dev-setup-secret` for the browser setup wizard.

Start the API:

```bash
uvicorn app.main:app --reload --port 8000
```

| URL | Purpose |
|---|---|
| http://127.0.0.1:8000/health | Health check |
| http://127.0.0.1:8000/api/docs | Swagger UI |
| http://127.0.0.1:8000/api/v1/meta | Runtime configuration summary |

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/ws` to
`http://127.0.0.1:8000`.

If your API is on a different port:

```bash
# PowerShell
$env:VITE_API_TARGET="http://127.0.0.1:8001"; npm run dev
# bash
VITE_API_TARGET=http://127.0.0.1:8001 npm run dev
```

> The dev server must listen on **port 5173** for the extension to attach,
> because that origin is in `extension/manifest.json`.

### 3. First-run setup

1. Open http://localhost:5173/setup
2. Enter the setup secret from `backend/.env` → `dev-setup-secret`
3. Create the administrator account (password: min 10 chars, letters + digits)

Setup permanently disables itself after the first successful run.

### 4. First exam

1. **Ujian → Buat ujian** — name, duration, `Pendaftaran dibuka`, and a Google
   Forms URL (`https://docs.google.com/...`).
2. **Roster peserta** — add participants manually or import a CSV
   (`full_name` required; `npm`, `email`, `group_name` optional).
3. Open http://localhost:5173/join, enter the Exam ID and a roster name.

---

## Quick start — Docker

### Development profile (hot reload, SQLite)

```bash
docker compose -f docker-compose.dev.yml up --build
```

| Service | URL |
|---|---|
| Frontend (Vite, hot reload) | http://localhost:5173 |
| API (uvicorn `--reload`) | http://localhost:8000 |

Setup secret: `dev-setup-secret`. The frontend container proxies `/api` and
`/ws` to the `api` service over the Compose network.

This profile also installs `requirements-dev.txt` inside the API container, so
the test suite runs there too:

```bash
docker compose -f docker-compose.dev.yml exec api python -m pytest -q
```

The production image installs **runtime dependencies only** — it has no pytest,
and that is intentional.

### Production profile (PostgreSQL + nginx)

One file to edit, one command to deploy. Everything else is automatic: the API
container waits for PostgreSQL, applies migrations, creates the initial
administrator, then starts.

```bash
cp .env.example .env
```

Fill in these five values in `.env`:

```env
POSTGRES_PASSWORD=<strong-random-password>
SECRET_KEY=<openssl rand -hex 32>
PUBLIC_BASE_URL=https://exam.heda.my.id
BOOTSTRAP_ADMIN_USERNAME=heda
BOOTSTRAP_ADMIN_PASSWORD=<strong-password, min 10 chars with letters+digits>
```

Generate secrets:

```bash
openssl rand -hex 32     # SECRET_KEY
```

Then:

```bash
docker compose up -d --build
```

That is the entire deployment. On first boot the API logs:

```
[entrypoint] Menunggu database siap…
[entrypoint] Menerapkan migrasi (alembic upgrade head)…
[entrypoint] Memeriksa akun administrator awal…
examguard.bootstrap: Admin awal dibuat: heda
[entrypoint] Menjalankan API pada port 8000…
```

Log in immediately at `https://<your-domain>` with
`BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` (default
`heda` / `WedhusGembel5`). Staff accounts use a **username**, not an email.
Change the password after the first login.

| Service | Where |
|---|---|
| Web (nginx: SPA + `/api` proxy + `/ws`) | host port **9200** → `http://127.0.0.1:9200` |
| API | internal only, `api:8000` on the Compose network |
| PostgreSQL | internal only, `db:5432` on the Compose network |

Verify:

```bash
curl -fsS http://127.0.0.1:9200/healthz     # nginx
curl -fsS http://127.0.0.1:9200/health      # API through the proxy
docker compose ps
docker compose logs -f api
```

#### Changing the host port

`WEB_PORT` in `.env` is the only host port that is published:

```env
WEB_PORT=9200      # default
API_PORT=8000      # in-container only, usually leave as is
```

The nginx config is rendered from a template at container start, so changing
`API_PORT` needs only a restart, not a rebuild.

#### After the first login

Optionally blank the bootstrap password so a leaked `.env` cannot re-seed an
account (it is already a no-op once an admin exists, but this removes the value
from disk):

```env
BOOTSTRAP_ADMIN_PASSWORD=
```

`SETUP_DISABLED=true` (the default) keeps `/setup` permanently closed.

### Portainer (prebuilt images, no clone)

Images are published to GHCR on every push to `master`:

```
ghcr.io/heda312/exam-guard-api:latest
ghcr.io/heda312/exam-guard-web:latest
```

Both are multi-arch (`amd64` + `arm64`).

1. **Stacks → Add stack**, name it `exam-guard`.
2. **Build method: Web editor** → paste `deploy/portainer-stack.yml`.
3. Set the environment variables (Portainer prompts for them):

   ```env
   POSTGRES_PASSWORD=<strong-random-password>
   SECRET_KEY=<openssl rand -hex 32>
   PUBLIC_BASE_URL=https://exam.heda.my.id
   BOOTSTRAP_ADMIN_USERNAME=heda
   BOOTSTRAP_ADMIN_PASSWORD=WedhusGembel5
   COOKIE_SECURE=true
   WEB_PORT=9200
   ```

4. **Deploy the stack.** First boot takes ~1 minute (wait for PostgreSQL →
   migrate → create admin → serve).

If the GHCR packages are private, either make them public or add a Portainer
registry credential (`https://ghcr.io` + a PAT with `read:packages`). See
`docs/DEPLOYMENT.md` §3 for details, including how to pin `IMAGE_TAG`.

Update later with **Stacks → exam-guard → Pull and redeploy**.

> **No images published yet?** GitHub Actions must build them. If it is blocked
> by a billing issue, either push the images once from your machine
> (`scripts/build-push-ghcr.ps1`) or use **Build method: Repository** with
> `portainer-build-stack.yml` — Portainer then builds on the host.

### Cloudflare Tunnel

Point the tunnel at the published host port — no TLS setup, no certificate
mounts, no `COOKIE_SECURE` changes:

```yaml
# /etc/cloudflared/config.yml
tunnel: examguard
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: exam.heda.my.id
    service: http://127.0.0.1:9200
    originRequest:
      connectTimeout: 30s
      noTLSVerify: true
  - service: http_status:404
```

```bash
cloudflared tunnel run examguard
```

Keep `PUBLIC_BASE_URL=https://exam.heda.my.id` and `COOKIE_SECURE=true` — TLS
terminates at Cloudflare, and nginx forwards `X-Forwarded-Proto` to the API.

### Serving the Docker stack over plain HTTP (LAN)

`COOKIE_SECURE=true` requires HTTPS. For a LAN deployment such as
`http://192.168.1.6:9200`:

```env
PUBLIC_BASE_URL=http://192.168.1.6:9200
CORS_ORIGINS=http://192.168.1.6:9200
COOKIE_SECURE=false
WEB_PORT=9200
```

> The extension only attaches to origins listed in its manifest. For a LAN host,
> add `http://192.168.1.6:9200/*` to both `host_permissions` and
> `content_scripts.matches` in `extension/manifest.json`, then reload the
> extension. The development profile on port 5173 needs no changes.

### TLS with Cloudflare Tunnel

```yaml
# /etc/cloudflared/config.yml
tunnel: examguard
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: exam.heda.my.id
    service: http://127.0.0.1:9200
    originRequest:
      connectTimeout: 30s
      noTLSVerify: true
  - service: http_status:404
```

```bash
cloudflared tunnel run examguard
```

TLS terminates at Cloudflare, so keep `COOKIE_SECURE=true` and
`PUBLIC_BASE_URL=https://exam.heda.my.id`. Details in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Useful Docker commands

```bash
docker compose logs -f api            # follow API logs
docker compose exec api alembic current
docker compose exec api alembic upgrade head
docker compose down                   # stop (keeps the volume)
docker compose down -v                # stop and delete the database volume
docker compose up -d --build api      # rebuild only the API
```

Backup / restore:

```bash
docker compose exec -T db pg_dump -U examguard -Fc examguard > backup.dump
docker compose exec -T db pg_restore -U examguard -d examguard --clean --if-exists < backup.dump
```

---

## Using the extension

Load `extension/` as an unpacked extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Pin **ExamGuard** to the toolbar

### Participant flow

There is **no popup** — clicking the icon is the participant entry point.

```
click icon ──▶ /join opens (or the existing participant tab is focused)
                        │
                        ▼
       Exam ID + full name + integrity commitment
                        │
                        ▼
             waiting room in that same tab
                        │ proctor starts the exam
                        ▼
   extension navigates that tab → Google Forms URL, verifies the load
                        │
                        ▼
        ready → monitoring/start → events captured and uploaded
```

The exam tab id is persisted in `chrome.storage.local`, so the launch survives
service-worker and browser restarts. If the waiting-room tab was closed, an
`examguard-watch` alarm still detects the exam going live and launches the form.

### Badge states

| Badge | Meaning |
|---|---|
| *(empty)* | No session yet |
| `…` | Registered, waiting for the exam to start |
| `ON` | Monitoring active, buffer empty |
| `1`–`500` | Monitoring active, N events pending upload |
| `!` | Attention required (token rejected, network failure, form not loaded) |

Monitoring status is also shown on the participant page. What is recorded, and
what is deliberately not: see [`extension/README.md`](extension/README.md).

---

## Configuration

Every variable is documented in [`docs/ENV.md`](docs/ENV.md). The ones that most
often need changing:

| Variable | Default | Notes |
|---|---|---|
| `WEB_PORT` | `9200` | Host port published by nginx; point Cloudflare Tunnel here |
| `DATABASE_URL` | `sqlite:///./data/examguard.db` | Use `postgresql+psycopg://…` for PostgreSQL |
| `AUTO_CREATE_TABLES` | `true` | `false` in production; the container runs `alembic upgrade head` |
| `SECRET_KEY` | `change-me-in-production` | **Must** be replaced in production |
| `BOOTSTRAP_ADMIN_USERNAME` | `heda` | With the password set, creates the first admin on boot |
| `BOOTSTRAP_ADMIN_PASSWORD` | `WedhusGembel5` | Min 10 chars, letters + digits. Change it after the first login |
| `BOOTSTRAP_ADMIN_EMAIL` | *(empty)* | Optional contact email; not used for login |
| `SETUP_SECRET` | *(empty)* | Only for the browser wizard; not needed in production |
| `SETUP_DISABLED` | `false` | `true` closes `/setup` permanently |
| `COOKIE_SECURE` | `true` | `false` only for plain HTTP |
| `CORS_ORIGINS` | localhost + prod origin | Comma-separated; defaults to `PUBLIC_BASE_URL` in Docker |
| `PARTICIPANT_IDENTITY_MODE` | `none` | `google` additionally requires a verified Google ID token |
| `ALLOWED_EXAM_URL_HOSTS` | `docs.google.com,forms.gle,forms.google.com` | Allow-list for exam form URLs |

> **Participant Google login is optional.** Spec v1.3 §5.2 requires it; this
> project treats it as an institutional policy instead. The reasoning and the
> one-line switch to restore strict compliance are in
> [`docs/DECISIONS.md`](docs/DECISIONS.md) (D-1).

---

## Tests

All backend test tooling comes from `requirements-dev.txt`:

```bash
cd backend
pip install -r requirements-dev.txt    # once
```

### Backend unit/integration — 102 tests

```bash
cd backend
python -m pytest -q
```

Runs against an isolated temporary SQLite database; development data is never
touched.

| File | Coverage |
|---|---|
| `test_names.py` | NFKC + casefold + whitespace, no fuzzy matching, NPM masking |
| `test_auth.py` | first-run setup, single-use setup, username login, CSRF, audit |
| `test_registration.py` | Exam-ID-only access, normalized match, typo rejection, NPM not a key, commitment, duplicate resume, ambiguous roster, rate limiting |
| `test_exam_lifecycle.py` | code generation, URL validation, server deadline, start/end, expiry worker, disconnect ≠ cheating |
| `test_monitoring.py` | readiness gating, token enforcement, incident correlation, idempotency, review audit, monitor state bundle, heartbeat timer, no false expiry before start |
| `test_rbac.py` | proctor scoping, per-permission denial, deactivation |
| `test_roster_reports.py` | CSV preview/commit, duplicates, CSV/XLSX export |
| `test_admin_deletes.py` | hard delete of roster entry / proctor / exam, cascades, live-exam guard |
| `test_participant_payload.py` | NPM masking, no roster leakage, roster immutability |
| `test_timestamps.py` | timezone-aware serialization (countdown regression guard) |
| `test_bootstrap.py` | unattended admin bootstrap, default credentials, idempotency |
| `test_config.py` | cookie domain, DSN assembly, unexpanded placeholder rejection, CORS fallback |

### Live API + WebSocket smoke tests

Start the API first, then:

```bash
cd backend
python e2e_smoke.py http://127.0.0.1:8000     # 36 checks
python ws_smoke.py  http://127.0.0.1:8000
```

### Frontend

```bash
cd frontend
npm run typecheck     # tsc --noEmit
npm run build         # production bundle
```

### Browser E2E (automated)

Loads the unpacked MV3 extension in Chromium and asserts the full participant
flow, plus dashboard and participant-page smoke tests.

```bash
cd frontend
npm install --no-save puppeteer-core
CHROME_PATH="<path-to-chromium>" node scripts/extension_e2e.mjs   http://127.0.0.1:5173   # 27 checks
CHROME_PATH="<path-to-chromium>" node scripts/dashboard_nav.mjs   http://127.0.0.1:5173 heda WedhusGembel5  # 13 checks
CHROME_PATH="<path-to-chromium>" node scripts/dashboard_data.mjs  http://127.0.0.1:5173 heda WedhusGembel5  # 11 checks
CHROME_PATH="<path-to-chromium>" node scripts/participant_flow.mjs http://127.0.0.1:5173 heda WedhusGembel5 # 7 checks
```

| Script | Covers |
|---|---|
| `extension_e2e.mjs` | no popup, tab persistence, bridge, registration, "Buka ujian" gate, same-tab form navigation, monitoring start, badge, realtime card, fast tab-switch incident, red focus overlay, time-up overlay |
| `dashboard_nav.mjs` | username login, every page renders, SPA navigation, no console errors |
| `dashboard_data.mjs` | create exam, detail/monitoring pages, every tab, delete from the UI |
| `participant_flow.mjs` | no premature "exam ended" popup, no auto-redirect, "Ujian sudah dibuka" + button |

### Deploy-level checks

```bash
python scripts/check_compose_interp.py        # Compose does not nest ${...}
python scripts/check_db_error_classifier.py   # permanent vs transient DB errors
python scripts/check_entrypoint_wait.py       # pre-flight fails fast, masks secrets
python scripts/check_portainer_stack.py       # Portainer stack is valid
python scripts/check_publish_workflow.py      # GHCR workflow builds both images
```

### Screenshots

```bash
cd frontend
node scripts/ui_shots.mjs http://127.0.0.1:5173
```

See [`docs/screenshots/`](docs/screenshots/README.md) (19 screens).

---

## Core behaviour

| Requirement | Implementation |
|---|---|
| Exam access = Exam ID only | `POST /api/v1/participant/register` takes `exam_code`; no PIN/token in the schema |
| Identity = Exam ID + normalized name | `names.normalize_name()` — NFKC → casefold → strip whitespace, exact key match |
| NPM informational only | No unique constraint; never compared during registration |
| Commitment checkbox | Re-validated server-side, version-pinned, server-generated timestamp |
| Server-authoritative timer | `exam_sessions.started_at/ends_at` set once; clients never submit time |
| Timer continues offline | Deadline lives in the DB; `worker.sweep_once()` expires sessions regardless of client presence |
| Proctor scoping | `require_exam_access()` on every exam-scoped route → 403 when unassigned or permission missing |
| Audit trail | `record_audit()` on setup, auth, exam lifecycle, roster, incident review, exports |
| Data minimisation | Events store `page_host` only; full URLs and query strings are discarded |
| Disconnection ≠ cheating | `CONNECTION_LOST` is a connection state; it never creates an incident |

Architecture, state machines, and the realtime flow:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/setup` says the setup secret is invalid | Local only: `SETUP_SECRET` in `backend/.env` differs from what you typed; restart the API after editing `.env` |
| Cannot log in after `docker compose up` | First boot only: check `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`, then `docker compose logs api \| grep -i bootstrap`. If the password worked before and now fails, it was changed in the UI — see "Wrong password after the first login worked" in docs/DEPLOYMENT.md, or reset with `backend/reset_password.py` |
| `docker compose logs api` shows "Bootstrap admin tidak lengkap" | Only one of the two bootstrap variables is set — set both or neither |
| Bootstrap password rejected | Policy requires ≥10 chars with letters **and** digits |
| Login succeeds but every request returns 401 | `COOKIE_SECURE=true` while browsing over plain HTTP — set it to `false` |
| `403 Token CSRF tidak valid` | The `eg_csrf` cookie was cleared; reload the page |
| Participant gets `Identitas tidak dapat diverifikasi` | Name does not normalize to exactly one roster entry, or the exam is not open for registration. Check the roster's *Kunci normalisasi* column |
| Registration blocked with "ambiguous roster" | Two roster rows share a normalized name; delete one |
| Form URL rejected | Must be HTTPS and on `ALLOWED_EXAM_URL_HOSTS` |
| Countdown shows `00:00` | Should not happen — timestamps are timezone-aware; `test_timestamps.py` guards this |
| Extension badge never leaves `…` | Exam not `LIVE` yet, or the extension cannot reach the API (check the origin in the manifest) |
| Extension does not attach | The page origin is not in `content_scripts.matches`; add it and reload the extension |
| `docker compose` fails with `POSTGRES_PASSWORD wajib diisi` | Required variables missing from `.env` |
| `alembic upgrade head` fails on SQLite | Use `AUTO_CREATE_TABLES=true` for local dev, or run migrations against PostgreSQL |

Admin recovery, session revocation, and timer correction procedures:
[`docs/RECOVERY.md`](docs/RECOVERY.md).

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data model, state machines, realtime flow |
| [`docs/API.md`](docs/API.md) | Endpoint reference with auth and permission notes |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Deviations from the spec and the reasoning |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Docker, nginx, Cloudflare Tunnel, backups, scaling |
| [`docs/RECOVERY.md`](docs/RECOVERY.md) | Admin recovery, password reset, timer correction |
| [`docs/TESTING.md`](docs/TESTING.md) | Test layout and manual verification steps |
| [`docs/ENV.md`](docs/ENV.md) | Every environment variable |
| [`extension/README.md`](extension/README.md) | Extension architecture and permissions |
| [`docs/screenshots/`](docs/screenshots/README.md) | UI screenshots |
