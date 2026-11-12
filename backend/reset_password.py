#!/usr/bin/env python3
"""Reset an ExamGuard staff password from inside the API container.

Use this when a deployment was bootstrapped once and the password has since been
changed (or forgotten): bootstrap never overwrites an existing admin, so the
value in ``BOOTSTRAP_ADMIN_PASSWORD`` is then stale.

Run it INSIDE the API container:

    docker exec -it exam-guard-api-1 python /tmp/reset_password.py <username> [new-password]

Without a password argument a random 14-character one is generated and printed
once. The account stays active and ``must_change_password`` is cleared, so the
new value works immediately.

The script is interactive-safe: it refuses to run against the test database and
always shows which database it is touching before committing.
"""
from __future__ import annotations

import secrets
import string
import sys

# Refuse to run against an in-memory database, which is never a real deployment.
DATABASE_URL = __import__("os").environ.get("DATABASE_URL", "")
if ":memory:" in DATABASE_URL:
    sys.exit("Refusing to run: DATABASE_URL is an in-memory (test) database.")

from sqlalchemy import select  # noqa: E402

from app.database import SessionLocal, engine  # noqa: E402
from app.models import User  # noqa: E402
from app.security import hash_password, verify_password  # noqa: E402


def generate_password(length: int = 14) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        candidate = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(c.isalpha() for c in candidate) and any(c.isdigit() for c in candidate):
            return candidate


def main() -> int:
    args = [arg for arg in sys.argv[1:] if arg not in {"-h", "--help"}]
    if "-h" in sys.argv or "--help" in sys.argv or not args:
        print(__doc__)
        print(
            "Usage: python reset_password.py <username> [new-password]\n"
            "       python reset_password.py heda                    # generates one\n"
            "       python reset_password.py heda 'SandiBaruKuat99'\n"
        )
        return 2

    username = args[0].strip().lower()
    new_password = args[1] if len(args) > 1 else generate_password()

    db = SessionLocal()
    try:
        user = db.scalar(select(User).where(User.username == username))
        if user is None:
            known = [u.username for u in db.scalars(select(User)).all()]
            print(f"Tidak ada akun dengan username {username!r}.")
            print(f"Akun yang ada: {known}")
            return 1

        # Describe the target database in an engine-agnostic way.
        if engine.url.get_backend_name() == "postgresql":
            from sqlalchemy import text

            with engine.connect() as connection:
                database = connection.execute(text("select current_database()")).scalar_one()
            target = f"PostgreSQL database {database!r}"
        else:
            target = f"SQLite file {engine.url.database!r}"
        same_as_new = bool(
            user.password_hash and verify_password(new_password, user.password_hash)
        )
        print(f"Target   : {target}")
        print(f"Akun     : {user.username} ({user.role}, active={user.is_active})")
        print(f"Password baru sama dengan yang tersimpan? {same_as_new}")

        user.password_hash = hash_password(new_password)
        user.is_active = True
        user.must_change_password = False
        db.commit()

        print()
        print("Password berhasil direset.")
        if len(args) <= 1:
            print(f"Password baru : {new_password}")
            print("(Simpan sekarang — tidak ditampilkan lagi.)")
        else:
            print("Password baru : (nilai yang kamu berikan)")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
