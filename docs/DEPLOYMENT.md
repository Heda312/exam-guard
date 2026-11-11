# Deployment

Two supported profiles:

1. **Docker Compose + PostgreSQL** — the production profile for
   `https://exam.heda.my.id`.
2. **Local server `192.168.1.6`** — same compose file, reachable over LAN.

---

## 1. Prerequisites

- Docker Engine 24+ with Compose v2
- A domain pointing at the host (for the production profile)
- TLS termination: Cloudflare Tunnel (recommended) or a reverse proxy with
  certificates

---

## 2. First deployment (production)

Deployment is: edit one env file, run one command. The API container waits for
PostgreSQL, applies migrations, creates the initial administrator, and starts.

```bash
git clone <repo> exam-guard && cd exam-guard
cp .env.example .env
```

Edit `.env`:

```env
# required
POSTGRES_PASSWORD=<strong-random-password>
SECRET_KEY=<openssl rand -hex 32>
PUBLIC_BASE_URL=https://exam.heda.my.id

# unattended first admin
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=<strong-password, min 10 chars, letters+digits>

# host port published by nginx (Cloudflare Tunnel targets this)
WEB_PORT=9200

# defaults that are already correct
APP_ENV=production
COOKIE_SECURE=true
SETUP_DISABLED=true
RUN_MIGRATIONS=true
```

Generate the secret:

```bash
openssl rand -hex 32     # SECRET_KEY
```

Deploy:

```bash
docker compose up -d --build
docker compose logs -f api
```

Expected log sequence on first boot:

```
[entrypoint] Menunggu database siap…
[entrypoint] Menerapkan migrasi (alembic upgrade head)…
[entrypoint] Memeriksa akun administrator awal…
examguard.bootstrap: Admin awal dibuat: admin@example.com
[entrypoint] Menjalankan API pada port 8000…
```

Verify:

```bash
curl -fsS http://127.0.0.1:9200/healthz
curl -fsS http://127.0.0.1:9200/health
```

Then sign in at `https://exam.heda.my.id` with the bootstrap credentials. The
account is flagged `must_change_password`, so you must set a new password before
continuing. `/setup` is closed permanently because `SETUP_DISABLED=true`.

Optionally remove the bootstrap password from disk afterwards (it is already a
no-op once an admin exists):

```env
BOOTSTRAP_ADMIN_PASSWORD=
```

---

## 3. Cloudflare Tunnel

The tunnel terminates TLS, so nginx serves plain HTTP on the host port
(`WEB_PORT`, default `9200`).

`/etc/cloudflared/config.yml` on the host:

```yaml
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

Notes:

- WebSocket upgrade works through the tunnel; nginx already sets
  `Upgrade`/`Connection` for `/ws/`.
- Because TLS ends at Cloudflare, the API must trust the forwarded headers —
  uvicorn runs with `--proxy-headers --forwarded-allow-ips *` in the image, and
  nginx forwards `X-Forwarded-Proto`.
- `COOKIE_SECURE=true` is required so the session cookie is only sent over HTTPS.

---

## 4. Local server profile (192.168.1.6)

The production compose file with plain-HTTP overrides:

```env
APP_ENV=development
PUBLIC_BASE_URL=http://192.168.1.6:9200
CORS_ORIGINS=http://192.168.1.6:9200
COOKIE_SECURE=false
WEB_PORT=9200
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=<strong-password>
```

```bash
docker compose up -d --build
```

Participants on the same network open `http://192.168.1.6:9200/join`.

> The extension manifest lists the production origin plus the local dev origins
> (`localhost:5173`/`127.0.0.1:5173`). To use the extension against a LAN host,
> add `http://192.168.1.6:9200/*` to both `host_permissions` and
> `content_scripts.matches` in `extension/manifest.json`, then reload the
> extension.

---

## 4b. Development profile (hot reload)

For day-to-day work use the development compose file — SQLite, `--reload`, and
Vite hot reload:

```bash
docker compose -f docker-compose.dev.yml up --build
```

| Service | URL | Notes |
|---|---|---|
| Frontend (Vite) | http://localhost:5173 | proxies `/api` and `/ws` to `api:8000` |
| API (uvicorn `--reload`) | http://localhost:8000 | `backend/app` mounted for reload |

Setup secret: `dev-setup-secret`. No PostgreSQL container and no migrations are
needed; tables are created automatically.

The extension attaches to `localhost:5173`, so this profile needs no manifest
changes.

---

## 5. Backups

Nightly logical backup with retention:

```bash
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F-%H%M)
mkdir -p /var/backups/examguard
docker compose exec -T db pg_dump -U examguard -Fc examguard \
  > "/var/backups/examguard/examguard-${STAMP}.dump"
find /var/backups/examguard -name '*.dump' -mtime +14 -delete
```

Restore:

```bash
docker compose stop api web
docker compose exec -T db pg_restore -U examguard -d examguard --clean --if-exists \
  < /var/backups/examguard/examguard-<stamp>.dump
docker compose start api web
```

Audit logs and monitoring events are append-only at the API level; a database
backup is the authoritative record.

---

## 6. Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on start (the entrypoint runs `alembic upgrade
head` before the API). To upgrade without migrations, set `RUN_MIGRATIONS=false`
for that deploy.

Check `/health` and the audit log page afterwards.

### Updating the host port or API port

`WEB_PORT` and `API_PORT` come from `.env`; the nginx config is rendered from a
template at container start, so only a restart is needed:

```bash
docker compose up -d
```

---

## 7. Operational checks

| Check | Command |
|---|---|
| API health | `curl -fsS https://exam.heda.my.id/health` |
| Container health | `docker compose ps` |
| Expiry worker running | `docker compose logs api \| grep "expired"` |
| Session cookie flags | DevTools → Application → Cookies (`HttpOnly`, `Secure`, `SameSite=Lax`) |
| Rate limiting active | 11 rapid `POST /api/v1/auth/login` requests → `429` |

---

## 8. Troubleshooting

### `dependency api failed to start` / `exam-guard-api-1 is unhealthy`

That message comes from the `web` container: it waits for the API healthcheck.
The real error is always in the API logs.

```bash
docker compose ps                          # which container is unhealthy/exited?
docker compose logs --tail=200 api         # entrypoint step that failed
docker inspect --format '{{json .State.Health}}' exam-guard-api-1
```

The entrypoint prints a `[entrypoint] GAGAL: …` hint naming the failing step.
The usual causes, in order of frequency:

| Log line | Cause | Fix |
|---|---|---|
| `Database tidak dapat dijangkau` | `db` is not ready, the password is wrong, or the `db_data` volume was created with a different password | check `docker compose logs db`; if the volume is stale and the data is disposable: `docker compose down -v && docker compose up -d --build` |
| same, with `could not translate host name` / `invalid dsn` | `@`, `/`, `?` or `%` in `POSTGRES_PASSWORD` breaks the generated URL | use an alphanumeric password, or set `DATABASE_URL` in `.env` with a URL-encoded password |
| `GAGAL: migrasi database error` | a migration failed (usually a pre-existing/inconsistent schema) | read the alembic traceback; check `alembic current` / `alembic history` |
| `BOOTSTRAP_ADMIN_PASSWORD ditolak` | first boot and the env password is < 10 chars or has no digit | set a valid `BOOTSTRAP_ADMIN_PASSWORD` (letters + digits), or empty both `BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` |
| `Address already in use` | `API_PORT` conflicts inside the container network | leave `API_PORT=8000` unless you know why |
| nothing after `Menjalankan API…` | uvicorn import/config error | the traceback is directly below that line |

After fixing `.env`, recreate only the affected containers:

```bash
docker compose up -d --force-recreate api web
```

Notes:

- The bootstrap step is skipped automatically once an administrator exists, so
  clearing or changing `BOOTSTRAP_ADMIN_*` after the first successful boot can
  never take the API down.
- `docker compose down -v` **deletes the database volume**. Back up first if the
  deployment already holds real data.
- If the API is healthy but `web` is not, check `docker compose logs web` and
  `docker compose exec web nginx -t`.

### Checking the API directly

```bash
docker compose exec api curl -fsS http://127.0.0.1:8000/health
docker compose exec web curl -fsS http://127.0.0.1/healthz
curl -fsS http://127.0.0.1:${WEB_PORT:-9200}/health
```

---

## 9. Scaling notes

- The API is a single container by design. Running multiple replicas requires:
  - a shared rate limiter (Redis), and
  - a shared WebSocket fan-out (Redis pub/sub) behind `app/ws.py`.
- ~80 concurrent participants is well within a single 1 vCPU / 1 GB container.
- PostgreSQL tuning beyond defaults is not needed at this scale.
