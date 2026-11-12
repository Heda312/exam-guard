"""username login for admins and proctors

Revision ID: 7c1f9a4d2b60
Revises: dea28976e3d8
Create Date: 2026-11-12 06:40:00.000000

Staff accounts now authenticate with a username instead of an email address.
The email column is kept for optional contact information.

Existing rows get a username derived from the local part of their email, with a
numeric suffix when that would collide.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "7c1f9a4d2b60"
down_revision: Union[str, None] = "dea28976e3d8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _derive_username(email: str | None, user_id: str) -> str:
    base = (email or "").split("@")[0].strip().lower()
    base = "".join(ch for ch in base if ch.isalnum() or ch in {"_", ".", "-"})
    if len(base) < 3:
        base = f"user{user_id[:6]}"
    return base[:64]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_columns = {column["name"] for column in inspector.get_columns("users")}

    with op.batch_alter_table("users") as batch_op:
        if "username" not in existing_columns:
            batch_op.add_column(sa.Column("username", sa.String(length=64), nullable=True))
        batch_op.alter_column("email", existing_type=sa.String(length=255), nullable=True)

    connection = op.get_bind()
    rows = connection.execute(sa.text("SELECT id, email, username FROM users")).fetchall()
    taken: set[str] = set()
    for user_id, email, username in rows:
        if username:
            taken.add(username)
            continue
        candidate = _derive_username(email, user_id)
        suffix = 1
        while candidate in taken:
            suffix += 1
            candidate = f"{_derive_username(email, user_id)[:58]}{suffix}"
        taken.add(candidate)
        connection.execute(
            sa.text("UPDATE users SET username = :username WHERE id = :id"),
            {"username": candidate, "id": user_id},
        )

    # Index names are not guaranteed to match between engines, so look them up.
    inspector = sa.inspect(connection)
    indexes = {index["name"]: index for index in inspector.get_indexes("users")}
    email_index = indexes.get("ix_users_email")

    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column("username", existing_type=sa.String(length=64), nullable=False)
        if "ix_users_username" not in indexes:
            batch_op.create_index("ix_users_username", ["username"], unique=True)
        # Email is no longer the login identifier, so it must not stay unique.
        if email_index is not None:
            if email_index.get("unique"):
                batch_op.drop_index("ix_users_email")
                batch_op.create_index("ix_users_email", ["email"], unique=False)
        else:
            batch_op.create_index("ix_users_email", ["email"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_index("ix_users_username")
        batch_op.drop_column("username")
