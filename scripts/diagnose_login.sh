#!/usr/bin/env bash
# Diagnose "password rejected after a successful first login" on a deployed host.
#
# Run it INSIDE the API container:
#
#   docker exec -it exam-guard-api-1 sh -c "python /app/scripts/diagnose_login.py" 2>/dev/null
#   # or, if the script is not in the image:
#   docker cp scripts/diagnose_login.py exam-guard-api-1:/tmp/diagnose_login.py
#   docker exec -it exam-guard-api-1 sh -c "cd /app && python /tmp/diagnose_login.py"
#
# It prints, without ever exposing a password:
#   - which admin accounts exist (username, role, active, last login)
#   - whether the BOOTSTRAP_ADMIN_PASSWORD in the environment still matches the
#     stored hash for the admin account
#   - the recent login audit trail
#
# The most common cause of a sudden "wrong password" is that the account was
# bootstrapped once with one password and later changed through the UI, while
# BOOTSTRAP_ADMIN_PASSWORD still holds the original value. Bootstrap is
# idempotent and never overwrites an existing admin.

set -eu

python - <<'PY'
import os
import sys

from sqlalchemy import select, text

from app.database import SessionLocal, engine
from app.models import AuditLog, User
from app.security import verify_password

db = SessionLocal()
print("=" * 68)
print("DATABASE")
print("=" * 68)
with engine.connect() as connection:
    row = connection.execute(text("SELECT current_database(), current_user")).first()
    print(f"  connected to db={row[0]} as user={row[1]}")

print()
print("=" * 68)
print("STAFF ACCOUNTS")
print("=" * 68)
users = db.scalars(select(User).where(User.role == "ADMIN").order_by(User.created_at)).all()
if not users:
    print("  NO ADMIN ACCOUNT EXISTS.")
    print("  The bootstrap step creates one; check the API logs for")
    print("  'Admin awal dibuat' or 'Admin sudah ada'.")
for user in users:
    print(f"  username={user.username!r}")
    print(f"    role            = {user.role}")
    print(f"    is_active       = {user.is_active}")
    print(f"    must_change_pwd = {user.must_change_password}")
    print(f"    created_at      = {user.created_at}")
    print(f"    last_login_at   = {user.last_login_at}")
    print(f"    has_password    = {bool(user.password_hash)}")
    print(f"    password_hash   = {(user.password_hash or '')[:32]}...")

print()
print("=" * 68)
print("DOES BOOTSTRAP_ADMIN_PASSWORD STILL MATCH THE STORED HASH?")
print("=" * 68)
bootstrap_password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD") or ""
bootstrap_username = (os.environ.get("BOOTSTRAP_ADMIN_USERNAME") or "").strip().lower()
if not bootstrap_password:
    print("  BOOTSTRAP_ADMIN_PASSWORD is not set in this container.")
    print("  (That is expected after the first boot, or when you cleared it.)")
else:
    print(f"  BOOTSTRAP_ADMIN_USERNAME = {bootstrap_username!r}")
    match_user = db.scalar(select(User).where(User.username == bootstrap_username))
    if match_user is None:
        print(f"  No account with username {bootstrap_username!r} exists!")
        print("  Usernames present:",
              [u.username for u in db.scalars(select(User)).all()])
    else:
        ok = verify_password(bootstrap_password, match_user.password_hash)
        print(f"  password in env matches stored hash : {ok}")
        if not ok:
            print()
            print("  >>> THIS IS THE CAUSE.")
            print("  The account was created with this password, but the")
            print("  password was later CHANGED (password change / another admin).")
            print("  Bootstrap never overwrites an existing admin, so the value")
            print("  in BOOTSTRAP_ADMIN_PASSWORD is now stale.")
            print()
            print("  Fix: use the CURRENT password, or reset it:")
            print("    python - <<'EOF'")
            print("    from app.database import SessionLocal")
            print("    from app.models import User")
            print("    from app.security import hash_password")
            print("    db = SessionLocal()")
            print(f"    u = db.query(User).filter_by(username='{bootstrap_username}').one()")
            print(f"    u.password_hash = hash_password('{bootstrap_password}')")
            print("    db.commit()")
            print("    EOF")
elif bootstrap_username:
    print(f"  BOOTSTRAP_ADMIN_USERNAME = {bootstrap_username!r} (no password set)")

print()
print("=" * 68)
print("RECENT LOGIN ATTEMPTS (audit log)")
print("=" * 68)
entries = db.scalars(
    select(AuditLog)
    .where(AuditLog.action.in_(["auth.login_success", "auth.login_failed", "auth.password_changed"]))
    .order_by(AuditLog.created_at.desc())
    .limit(15)
).all()
if not entries:
    print("  (none recorded)")
for entry in entries:
    meta = entry.metadata_ if hasattr(entry, "metadata_") else None
    reason = ""
    if isinstance(meta, dict):
        reason = meta.get("reason") or meta.get("role") or ""
    print(f"  {entry.created_at}  {entry.action:22} actor={entry.actor_label!r} {reason}")

db.close()
print()
print("Done.")
PY
