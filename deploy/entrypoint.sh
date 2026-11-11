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
echo "[entrypoint] Menunggu database siap…"

if ! python - <<'PY'
import sys
import time

from sqlalchemy import text

from app.database import engine

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
        time.sleep(2)

print(f"[entrypoint] Database tidak dapat dijangkau: {last_error}", file=sys.stderr)
sys.exit(1)
PY
then
  echo "[entrypoint] GAGAL: database tidak bisa dihubungi dalam 120 detik." >&2
  echo "[entrypoint] Periksa:" >&2
  echo "[entrypoint]   - 'docker compose logs db' (container db harus healthy)" >&2
  echo "[entrypoint]   - POSTGRES_USER/POSTGRES_DB/POSTGRES_PASSWORD di .env" >&2
  echo "[entrypoint]   - jika volume db sudah pernah dibuat dengan password lain," >&2
  echo "[entrypoint]     API tidak akan pernah bisa login ke database itu." >&2
  echo "[entrypoint]   - karakter '@', '/', '?' atau '%' di POSTGRES_PASSWORD dapat" >&2
  echo "[entrypoint]     merusak DATABASE_URL; gunakan password alfanumerik atau" >&2
  echo "[entrypoint]     set DATABASE_URL eksplisit (URL-encoded)." >&2
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
    echo "[entrypoint] Periksa BOOTSTRAP_ADMIN_EMAIL dan BOOTSTRAP_ADMIN_PASSWORD:" >&2
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
