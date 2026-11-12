"""ExamGuard API application factory."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .api import admin_users, auth, exams, monitoring, participant
from .config import settings
from .database import create_all
from .ws_routes import router as ws_router
from .worker import run_maintenance_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("examguard")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.auto_create_tables:
        create_all()
        logger.info("Database tables ensured")
    if settings.is_production and settings.secret_key == "change-me-in-production":
        logger.warning("SECRET_KEY masih nilai default — segera ganti untuk produksi.")

    stop_event = asyncio.Event()
    task = asyncio.create_task(run_maintenance_loop(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


def create_app() -> FastAPI:
    app = FastAPI(
        title=f"{settings.app_name} API",
        version=__version__,
        description=(
            "ExamGuard — examination session & browser activity monitoring.\n\n"
            "Participant access is validated by Exam ID + normalized name against the "
            "exam roster. NPM is informational only. No join token or PIN exists."
        ),
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-CSRF-Token", "X-Participant-Token", "Accept"],
        expose_headers=["X-Participant-Token", "Content-Disposition"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        return response

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):  # pragma: no cover
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "Terjadi kesalahan pada server."})

    prefix = settings.api_prefix
    app.include_router(auth.router, prefix=prefix)
    app.include_router(admin_users.router, prefix=prefix)
    app.include_router(exams.router, prefix=prefix)
    app.include_router(monitoring.router, prefix=prefix)
    app.include_router(participant.router, prefix=prefix)
    app.include_router(ws_router)

    @app.get("/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok", "app": settings.app_name, "version": __version__, "env": settings.app_env}

    @app.get("/api/v1/meta", tags=["meta"])
    def meta() -> dict:
        return {
            "app_name": settings.app_name,
            "version": __version__,
            "participant_identity_mode": settings.participant_identity_mode,
            "commitment_version": settings.commitment_version,
            "heartbeat_interval_seconds": settings.heartbeat_interval_seconds,
            "heartbeat_timeout_seconds": settings.heartbeat_timeout_seconds,
        }

    return app


app = create_app()
