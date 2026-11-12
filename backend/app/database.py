"""Database engine, session factory and declarative base."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


def _prepare_sqlite_directory(url: str) -> None:
    if not url.startswith("sqlite"):
        return
    # sqlite:///./data/examguard.db -> ./data/examguard.db
    raw_path = url.split("///", 1)[-1]
    if raw_path in {"", ":memory:"}:
        return
    path = Path(raw_path)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.parent.mkdir(parents=True, exist_ok=True)


_prepare_sqlite_directory(settings.database_url)

def _is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


# Connection pool sizing. WebSockets no longer hold connections (see
# ws_routes.py), but a single exam still generates bursts: 80 participants
# registering at once, then heartbeats every 10s, plus the dashboard polling
# monitor state. The pool must absorb those bursts without 30s timeouts.
# Tunable via env so the tiny-pool regression test can prove the point.
DB_POOL_SIZE = int(os.environ.get("DB_POOL_SIZE", "10"))
DB_MAX_OVERFLOW = int(os.environ.get("DB_MAX_OVERFLOW", "20"))
DB_POOL_TIMEOUT = int(os.environ.get("DB_POOL_TIMEOUT", "10"))
DB_POOL_RECYCLE = int(os.environ.get("DB_POOL_RECYCLE", "1800"))

connect_args = {}
if _is_sqlite(settings.database_url):
    connect_args = {"check_same_thread": False}

engine_kwargs: dict = {
    "pool_size": DB_POOL_SIZE,
    "max_overflow": DB_MAX_OVERFLOW,
    "pool_timeout": DB_POOL_TIMEOUT,
    "pool_recycle": DB_POOL_RECYCLE,
    "pool_pre_ping": True,
    "future": True,
    "connect_args": connect_args,
}

engine: Engine = create_engine(settings.database_url, **engine_kwargs)

if _is_sqlite(settings.database_url):

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - driver level
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_all() -> None:
    from . import models  # noqa: F401  (register mappers)

    Base.metadata.create_all(bind=engine)


def reset_database_for_tests() -> None:
    """Drop and recreate all tables. Only used by the test-suite."""
    from . import models  # noqa: F401

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


__all__ = ["Base", "engine", "SessionLocal", "get_db", "create_all", "reset_database_for_tests"]

# Ensure the environment variable used by alembic is available.
os.environ.setdefault("EXAMGUARD_DATABASE_URL", settings.database_url)
