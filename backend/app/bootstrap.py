"""Unattended first-boot administrator bootstrap.

Lets a production deployment start with nothing but a filled-in ``.env``:

1. ``deploy/entrypoint.sh`` waits for the database and applies migrations.
2. This module creates the initial administrator when
   ``BOOTSTRAP_ADMIN_EMAIL`` and ``BOOTSTRAP_ADMIN_PASSWORD`` are set and no
   administrator exists yet.
3. It then marks first-run setup as completed so ``/setup`` is permanently
   disabled — no manual step in the browser.

Behaviour is idempotent: running it again is a no-op unless the configured
account is missing.
"""
from __future__ import annotations

import logging
import sys

from sqlalchemy import select

from .config import settings
from .database import SessionLocal
from .models import AppSetting, User
from .security import hash_password, validate_password_strength

logger = logging.getLogger("examguard.bootstrap")

SETUP_COMPLETED_KEY = "setup_completed"


def _mark_setup_completed(db) -> None:
    row = db.get(AppSetting, SETUP_COMPLETED_KEY)
    if row is None:
        db.add(AppSetting(key=SETUP_COMPLETED_KEY, value="true"))
    else:
        row.value = "true"


def ensure_bootstrap_admin() -> int:
    """Create the initial admin if configured. Returns an exit code."""
    email = (settings.bootstrap_admin_email or "").strip().lower()
    password = settings.bootstrap_admin_password or ""
    full_name = (settings.bootstrap_admin_name or "Administrator").strip()

    if not email and not password:
        logger.info(
            "BOOTSTRAP_ADMIN_EMAIL/PASSWORD tidak diset — lewati pembuatan admin otomatis."
        )
        return 0

    if not email or not password:
        logger.error(
            "Bootstrap admin tidak lengkap: isi BOOTSTRAP_ADMIN_EMAIL dan "
            "BOOTSTRAP_ADMIN_PASSWORD sekaligus, atau kosongkan keduanya."
        )
        return 1

    try:
        validate_password_strength(password)
    except ValueError as exc:
        logger.error("BOOTSTRAP_ADMIN_PASSWORD ditolak: %s", exc)
        return 1

    db = SessionLocal()
    try:
        existing_admin = db.scalar(select(User).where(User.role == "ADMIN").limit(1))
        if existing_admin is not None:
            # Already bootstrapped: make sure setup stays closed and move on.
            _mark_setup_completed(db)
            db.commit()
            logger.info(
                "Admin sudah ada (%s) — bootstrap dilewati.", existing_admin.email
            )
            return 0

        clash = db.scalar(select(User).where(User.email == email))
        if clash is not None:
            # Same email exists with a non-admin role: promote rather than fail.
            clash.role = "ADMIN"
            clash.is_active = True
            clash.password_hash = hash_password(password)
            clash.must_change_password = True
            _mark_setup_completed(db)
            db.commit()
            logger.warning("Akun %s dipromosikan menjadi ADMIN.", email)
            return 0

        admin = User(
            email=email,
            full_name=full_name,
            password_hash=hash_password(password),
            role="ADMIN",
            is_active=True,
            must_change_password=True,
        )
        db.add(admin)
        db.flush()
        _mark_setup_completed(db)
        db.commit()
        logger.info("Admin awal dibuat: %s", email)
        return 0
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Bootstrap admin gagal")
        return 1
    finally:
        db.close()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    return ensure_bootstrap_admin()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
