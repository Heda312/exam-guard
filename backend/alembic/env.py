"""Alembic environment for ExamGuard.

Reads the database URL from EXAMGUARD_DATABASE_URL (falling back to the app
settings), so the same migrations work for SQLite (dev) and PostgreSQL (prod).
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.database import Base  # noqa: E402
from app import models  # noqa: F401,E402  (register mappers)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

database_url = os.environ.get("EXAMGUARD_DATABASE_URL") or settings.database_url
config.set_main_option("sqlalchemy.url", database_url)

target_metadata = Base.metadata


def render_item(type_, obj, autogen_context):
    """Render the custom UTCDateTime type as a portable sa.DateTime."""
    if type_ == "type" and obj.__class__.__name__ == "UTCDateTime":
        autogen_context.imports.add("import sqlalchemy as sa")
        return "sa.DateTime(timezone=True)"
    return False


def _configure_kwargs() -> dict:
    return {
        "target_metadata": target_metadata,
        "compare_type": True,
        "render_item": render_item,
    }


def run_migrations_offline() -> None:
    context.configure(
        url=database_url,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_configure_kwargs(),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            render_as_batch=connection.dialect.name == "sqlite",
            **_configure_kwargs(),
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
