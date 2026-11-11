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

```bash
git clone <repo> exam-guard && cd exam-guard
cp .env.example .env
```

Edit `.env`:

```env
APP_ENV=production
PUBLIC_BASE_URL=https://exam.heda.my.id
CORS_ORIGINS=https://exam.heda.my.id

POSTGRES_DB=examguard
POSTGRES_USER=examguard
POSTGRES_PASSWORD=<strong-random-password>

SECRET_KEY=<openssl rand -hex 32>
SETUP_SECRET=<openssl rand -hex 24>
SETUP_DISABLED=false

COOKIE_SECURE=true
COOKIE_DOMAIN=
PARTICIPANT_IDENTITY_MODE=none

AUTO_CREATE_TABLES=false
HTTP_PORT=8080
```

Generate secrets:

```bash
openssl rand -hex 32     # SECRET_KEY
openssl rand -hex 24     # SETUP_SECRET
```

Start the stack and apply migrations:

```bash
docker compose up -d --build
docker compose exec api alembic upgrade head
docker compose logs -f api
```

Verify:

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/health
```

Then open `https://exam.heda.my.id/setup` **once** and create the administrator
using `SETUP_SECRET`. Setup disables itself permanently.

After setup, harden the environment:

```env
SETUP_SECRET=
SETUP_DISABLED=true
```

and restart: `docker compose up -d`.

---

## 3. Cloudflare Tunnel

The tunnel terminates TLS, so nginx serves plain HTTP on port 8080.

`/etc/cloudflared/config.yml` on the host:

```yaml
tunnel: examguard
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: exam.heda.my.id
    service: http://127.0.0.1:8080
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
PUBLIC_BASE_URL=http://192.168.1.6:8080
CORS_ORIGINS=http://192.168.1.6:8080
COOKIE_SECURE=false
HTTP_PORT=8080
```

```bash
docker compose up -d --build
```

Participants on the same network open `http://192.168.1.6:8080/join`.

> The extension manifest lists the production origin plus the local dev origins
> (`localhost:5173`/`127.0.0.1:5173`). To use the extension against a LAN host,
> add `http://192.168.1.6:8080/*` to both `host_permissions` and
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
docker compose build
docker compose up -d
docker compose exec api alembic upgrade head
```

Check `/health` and the audit log page afterwards.

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

## 8. Scaling notes

- The API is a single container by design. Running multiple replicas requires:
  - a shared rate limiter (Redis), and
  - a shared WebSocket fan-out (Redis pub/sub) behind `app/ws.py`.
- ~80 concurrent participants is well within a single 1 vCPU / 1 GB container.
- PostgreSQL tuning beyond defaults is not needed at this scale.
