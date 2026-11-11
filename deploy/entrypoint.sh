#!/bin/sh
# ExamGuard API entrypoint.
#
# Makes `docker compose up -d --build` a complete deployment: wait for the
# database, apply migrations, create the initial administrator, then start the
# server. Every step is idempotent, so restarts are safe.
set -e

echo "[entrypoint] Menunggu database siap…"
python - <<'PY'
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

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Menerapkan migrasi (alembic upgrade head)…"
  alembic upgrade head
  echo "[entrypoint] Migrasi selesai."
else
  echo "[entrypoint] RUN_MIGRATIONS=false — migrasi dilewati."
fi

if [ "${BOOTSTRAP_ADMIN_ENABLED:-true}" = "true" ]; then
  echo "[entrypoint] Memeriksa akun administrator awal…"
  python -m app.bootstrap
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
