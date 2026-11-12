# Deployment

Three supported profiles:

1. **Docker Compose + PostgreSQL** — the production profile for
   `https://exam.heda.my.id`.
2. **Local server `192.168.1.6`** — same compose file, reachable over LAN.
3. **Portainer stack** — pulls prebuilt images from GHCR, no git clone needed.

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
BOOTSTRAP_ADMIN_USERNAME=heda
BOOTSTRAP_ADMIN_PASSWORD=WedhusGembel5

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
examguard.bootstrap: Admin awal dibuat: heda
[entrypoint] Menjalankan API pada port 8000…
```

Verify:

```bash
curl -fsS http://127.0.0.1:9200/healthz
curl -fsS http://127.0.0.1:9200/health
```

Then sign in at `https://exam.heda.my.id` with the bootstrap credentials
(`BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`, default
`heda` / `WedhusGembel5`). Staff accounts authenticate with a **username**, not an
email. `/setup` is closed permanently because `SETUP_DISABLED=true`.

Change the password right after the first login (`/setup` will not help you
later), then optionally remove it from disk — the bootstrap step is already a
no-op once an admin exists:

```env
BOOTSTRAP_ADMIN_PASSWORD=
```

---

## 3. Portainer (prebuilt images from GHCR)

Use this when you manage containers through Portainer and do not want to clone
the repository onto the host.

Images are published automatically by `.github/workflows/publish-images.yml` on
every push to `master`:

```
ghcr.io/heda312/exam-guard-api:latest
ghcr.io/heda312/exam-guard-web:latest
```

Both are multi-arch (`linux/amd64` + `linux/arm64`), so they also run on Oracle
Cloud ARM instances and Raspberry Pi.

> **If the images do not exist yet:** the workflow needs GitHub Actions, which
> fails with *"The job was not started because your account is locked due to a
> billing issue"* when the account has a billing problem. In that case either
> build the images once from your own machine
> ([Publishing images manually](#publishing-images-manually)) or let Portainer
> build from the repo ([Build from Git instead](#build-from-git-instead)).

### Deploy

1. **Stacks → Add stack**, name it `exam-guard`.
2. **Build method: Web editor**, then paste `deploy/portainer-stack.yml`.
3. Scroll to **Environment variables** and set at least:

   | Variable | Example | Notes |
   |---|---|---|
   | `POSTGRES_PASSWORD` | `S3cretDbPass` | **Required.** Changing it later does not alter an existing volume |
   | `SECRET_KEY` | output of `openssl rand -hex 32` | **Required.** Signs session cookies |
   | `PUBLIC_BASE_URL` | `https://exam.heda.my.id` | Must match the browser origin |
   | `BOOTSTRAP_ADMIN_USERNAME` | `heda` | Created on first boot only |
   | `BOOTSTRAP_ADMIN_PASSWORD` | `WedhusGembel5` | Change after the first login |
   | `COOKIE_SECURE` | `true` | `true` for HTTPS, `false` for plain LAN HTTP |
   | `WEB_PORT` | `9200` | Host port; point Cloudflare Tunnel here |

4. **Deploy the stack.**

First boot takes a minute: the API waits for PostgreSQL, runs migrations, creates
the administrator, then serves. Watch **Containers → exam-guard-api-1 → Logs**.

### Private packages

GHCR packages are private by default. Either make them public (GitHub → your
profile → Packages → *exam-guard-api* → Package settings → Change visibility), or
add a registry credential in Portainer:

**Registries → Add registry → Custom registry**
- URL: `https://ghcr.io`
- Username: your GitHub username
- Password: a PAT with the `read:packages` scope

### Updating

**Stacks → exam-guard → Pull and redeploy** (tick *Re-pull image*). Migrations run
automatically on start.

To pin a specific build instead of `latest`, set `IMAGE_TAG` to a tag produced by
the workflow, for example `sha-8a48fbd` or `v1.4.0`.

### Differences from `docker-compose.yml`

| | `docker-compose.yml` | `deploy/portainer-stack.yml` |
|---|---|---|
| Build | builds from source | pulls prebuilt images |
| Needs the repo | yes | no |
| `API_PORT` | configurable | fixed at `8000` (internal only) |
| Host port | `WEB_PORT` | `WEB_PORT` |

### Publishing images manually

If GitHub Actions is unavailable (billing lock, no runner minutes), build and
push the same images from any machine with Docker:

```powershell
# PowerShell (Windows)
$env:GHCR_OWNER = "heda312"
$env:GHCR_TOKEN = "<PAT with write:packages>"
.\scripts\build-push-ghcr.ps1
```

```bash
# bash (Linux/macOS)
GHCR_OWNER=heda312 GHCR_TOKEN=<PAT> ./scripts/build-push-ghcr.sh

# single architecture is much faster
PLATFORMS=linux/amd64 GHCR_OWNER=heda312 GHCR_TOKEN=<PAT> ./scripts/build-push-ghcr.sh
```

The script logs in to `ghcr.io`, builds both images with buildx, and pushes them
with the tag from `IMAGE_TAG` (default `latest`).

Create the PAT at **GitHub → Settings → Developer settings → Personal access
tokens** with the `write:packages` scope (a classic token). The first push
creates the packages.

After pushing, make the packages public (**GitHub → your profile → Packages →
package → Package settings → Change visibility**) or add a Portainer registry
credential so the stack can pull them.

### Build from Git instead

If you would rather not deal with a registry at all, Portainer can clone the repo
and build the images on the host:

**Stacks → Add stack → Build method: Repository**

| Field | Value |
|---|---|
| Repository URL | `https://github.com/Heda312/exam-guard` |
| Repository reference | `master` |
| Compose path | `deploy/portainer-build-stack.yml` |

Set the same environment variables as above, then **Deploy**. The first build
takes a few minutes (`npm ci` + `pip install`) and needs ~2 GB free disk.

Trade-offs: no registry, no `git pull` on the host, but every redeploy rebuilds
and the images stay local to that Portainer instance.

---

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
BOOTSTRAP_ADMIN_USERNAME=heda
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

Portainer stacks: **Stacks → exam-guard → Pull and redeploy** instead.

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
| `Konfigurasi tidak valid: … placeholder …` | `DATABASE_URL` contained a literal `${...}` — Compose does not expand `${VAR}` nested inside a default value | update `docker-compose.yml` (fixed in this release) or set `DATABASE_URL` explicitly in `.env` |
| `Kesalahan permanen … password authentication failed` | `POSTGRES_PASSWORD` does not match the existing `db_data` volume | restore the old password, or `docker compose down -v` (deletes data) |
| `Kesalahan permanen … database/role does not exist` | `POSTGRES_DB` / `POSTGRES_USER` mismatch | align `.env` with the volume, or recreate it |
| `Kesalahan permanen … could not translate host name` | wrong service name or container not on the compose network | keep `POSTGRES_HOST=db` |
| `Database tidak bisa dihubungi` after 120 s | `db` never became reachable (still starting, or resource-starved) | `docker compose logs db`, `docker compose ps` |
| `GAGAL: migrasi database error` | a migration failed (usually a pre-existing/inconsistent schema) | read the alembic traceback; check `alembic current` / `alembic history` |
| `BOOTSTRAP_ADMIN_PASSWORD ditolak` | first boot and the env password is < 10 chars or has no digit | set a valid `BOOTSTRAP_ADMIN_PASSWORD` (letters + digits), or empty both `BOOTSTRAP_ADMIN_USERNAME`/`PASSWORD` |
| nothing after `Menjalankan API…` | uvicorn import/config error | the traceback is directly below that line |

Permanent errors now abort in about a second instead of retrying for two
minutes, so the failure is reported instead of leaving the container "Waiting".

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
