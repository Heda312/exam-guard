# ---------- Backend image ----------
FROM python:3.12-slim AS backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini

# Entrypoint runs migrations + optional admin bootstrap before the server.
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /app/data \
    && adduser --disabled-password --gecos "" appuser \
    && chown -R appuser:appuser /app
USER appuser

# 8000 is the in-container port; the host port is set by HTTP_PORT in .env.
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${API_PORT:-8000}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
