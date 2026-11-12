#!/bin/sh
# ExamGuard API entrypoint.
#
# Makes `docker compose up -d --build` a complete deployment: wait for the
# database, apply migrations, create the initial administrator, then start the
# server. Every step is idempotent, so restarts are safe.
#
# Each step prints a specific hint on failure: `docker compose logs api` is the
# first thing to read when the API container is unhealthy.
set -e

echo "[entrypoint] Konfigurasi: APP_ENV=${APP_ENV:-production} API_PORT=${API_PORT:-8000} RUN_MIGRATIONS=${RUN_MIGRATIONS:-true} BOOTSTRAP_ADMIN_ENABLED=${BOOTSTRAP_ADMIN_ENABLED:-true}"

# ---------------------------------------------------------------------------
# 0. Validate configuration BEFORE waiting on the database.
#
# A malformed DATABASE_URL (for example a Compose placeholder that was never
# expanded) used to surface as "database unreachable" after a 120 s wait, which
# hid the real problem. Fail in under a second instead.
# ---------------------------------------------------------------------------
if ! python - <<'PY'
import sys

try:
    from app.config import settings
except Exception as exc:  # noqa: BLE001
    print(f"[entrypoint] Konfigurasi tidak valid: {exc}", file=sys.stderr)
    sys.exit(1)

url = settings.database_url
# Print the DSN with the password masked so the log is safe to share.
masked = url
if "://" in url and "@" in url:
    scheme, rest = url.split("://", 1)
    credentials, host = rest.rsplit("@", 1)
    user = credentials.split(":", 1)[0]
    masked = f"{scheme}://{user}:***@{host}"
print(f"[entrypoint] DATABASE_URL={masked}")
sys.exit(0)
PY
then
  echo "[entrypoint] GAGAL: konfigurasi aplikasi tidak valid (lihat pesan di atas)." >&2
  echo "[entrypoint] Periksa .env — terutama DATABASE_URL dan SECRET_KEY." >&2
  exit 1
fi

echo "[entrypoint] Menunggu database siap…"

# ---------------------------------------------------------------------------
# 1. Wait for PostgreSQL, distinguishing "still starting" from "will never work".
#
# Wrong credentials, a missing database or an unresolvable host will never fix
# themselves, so those exit immediately with a specific hint. Only connection
# errors that look transient are retried.
# ---------------------------------------------------------------------------
if ! python - <<'PY'
import sys
import time

from sqlalchemy import text

from app.database import engine

# Substrings that mean "retrying will not help".
PERMANENT = (
    "password authentication failed",
    "authentication failed",
    "role \"",
    "does not exist",
    "could not translate host name",
    "name or service not known",
    "nodename nor servname",
    "invalid dsn",
    "invalid connection option",
    "invalid url",
    "no password supplied",
)

deadline = time.time() + 120
last_error = None
while time.time() < deadline:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        print("[entrypoint] Database siap.")
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        last_error = exc
        message = str(exc).lower()
        if any(marker in message for marker in PERMANENT):
            print(f"[entrypoint] Kesalahan permanen saat menghubungi database: {exc}", file=sys.stderr)
            sys.exit(2)
        time.sleep(2)

print(f"[entrypoint] Database tidak dapat dijangkau: {last_error}", file=sys.stderr)
sys.exit(1)
PY
then
  echo "[entrypoint] GAGAL: database tidak bisa dihubungi." >&2
  echo "[entrypoint] Bila pesan di atas menyebut 'password authentication failed'," >&2
  echo "[entrypoint] 'role/database does not exist' atau 'could not translate host name'," >&2
  echo "[entrypoint] masalahnya permanen — periksa .env:" >&2
  echo "[entrypoint]   - POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD harus sama" >&2
  echo "[entrypoint]     dengan yang dipakai container db." >&2
  echo "[entrypoint]   - Jika volume db_data sudah pernah dibuat dengan password lain," >&2
  echo "[entrypoint]     password baru TIDAK berlaku. Pilihan:" >&2
  echo "[entrypoint]       a) kembalikan POSTGRES_PASSWORD ke nilai lama, atau" >&2
  echo "[entrypoint]       b) 'docker compose down -v' (MENGHAPUS semua data) lalu up lagi." >&2
  echo "[entrypoint]   - Karakter '@', '/', '?', '#' atau '%' di POSTGRES_PASSWORD dapat" >&2
  echo "[entrypoint]     merusak URL; gunakan password alfanumerik." >&2
  echo "[entrypoint]   - 'docker compose logs db' untuk melihat status PostgreSQL." >&2
  exit 1
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Menerapkan migrasi (alembic upgrade head)…"
  if ! alembic upgrade head; then
    echo "[entrypoint] GAGAL: migrasi database error (lihat pesan alembic di atas)." >&2
    echo "[entrypoint] Jika database lama/inkonsisten, cek 'alembic current' dan" >&2
    echo "[entrypoint] 'alembic history' sebelum melakukan perubahan manual." >&2
    exit 1
  fi
  echo "[entrypoint] Migrasi selesai."
else
  echo "[entrypoint] RUN_MIGRATIONS=false — migrasi dilewati."
fi

if [ "${BOOTSTRAP_ADMIN_ENABLED:-true}" = "true" ]; then
  echo "[entrypoint] Memeriksa akun administrator awal…"
  if ! python -m app.bootstrap; then
    echo "[entrypoint] GAGAL: bootstrap administrator awal ditolak." >&2
    echo "[entrypoint] Periksa BOOTSTRAP_ADMIN_USERNAME dan BOOTSTRAP_ADMIN_PASSWORD:" >&2
    echo "[entrypoint]   - minimal ${PASSWORD_MIN_LENGTH:-10} karakter, harus ada huruf + angka" >&2
    echo "[entrypoint]   - isi keduanya, atau kosongkan keduanya" >&2
    echo "[entrypoint]   - jika admin sudah ada, nilai ini diabaikan (tidak akan gagal)" >&2
    exit 1
  fi
else
  echo "[entrypoint] BOOTSTRAP_ADMIN_ENABLED=false — bootstrap admin dilewati."
fi

echo "[entrypoint] Menjalankan API pada port ${API_PORT:-8000}…"
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${API_PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips "*" \
  --workers "${API_WORKERS:-1}"
