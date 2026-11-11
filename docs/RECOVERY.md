# Recovery Runbook

All procedures below require **server-level access**. ExamGuard intentionally
provides no self-service admin recovery through the web UI.

---

## 1. Lost the only admin password

```bash
docker compose exec api python - <<'PY'
from app.database import SessionLocal
from app.models import User
from app.security import hash_password

db = SessionLocal()
admin = db.query(User).filter(User.role == "ADMIN").order_by(User.created_at).first()
if admin is None:
    raise SystemExit("No admin account found — run the setup procedure instead.")

admin.password_hash = hash_password("GantiDenganSandiKuat123")
admin.must_change_password = True
admin.is_active = True
db.commit()
print("Password reset for", admin.email)
PY
```

Then sign in and change the password immediately.

---

## 2. Admin account locked / deactivated

```bash
docker compose exec api python - <<'PY'
from app.database import SessionLocal
from app.models import User

db = SessionLocal()
for user in db.query(User).filter(User.role == "ADMIN").all():
    user.is_active = True
    print("reactivated", user.email)
db.commit()
PY
```

---

## 3. Re-create the initial administrator from `.env`

The Docker entrypoint creates the first admin automatically from
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. That step is a no-op once
any administrator exists, so use one of these when you need to seed one again:

```bash
# Option A: no admin exists yet
docker compose up -d
docker compose logs api | grep -i bootstrap
```

```bash
# Option B: force a reset of the existing admin password (see section 1),
# or temporarily promote the account whose email is in BOOTSTRAP_ADMIN_EMAIL.
# Remove the guard by demoting the current admins first:
docker compose exec api python - <<'PY'
from sqlalchemy import select
from app.database import SessionLocal
from app.models import User

db = SessionLocal()
for user in db.scalars(select(User).where(User.role == "ADMIN")).all():
    user.role = "PROCTOR"
db.commit()
print("no admins left - restart the api container to re-bootstrap")
PY
```

```bash
docker compose restart api
docker compose logs -f api
```

---

## 4. Re-enable the browser setup wizard

Only needed if you are not using the env-based bootstrap. Setup is disabled once
`app_settings.setup_completed = 'true'` or any admin exists.

```bash
# 1. Allow the setup page again
docker compose exec api python - <<'PY'
from app.database import SessionLocal
from app.models import AppSetting

db = SessionLocal()
row = db.get(AppSetting, "setup_completed")
if row:
    row.value = "false"
else:
    db.add(AppSetting(key="setup_completed", value="false"))
db.commit()
print("setup re-enabled")
PY
```

```bash
# 2. Set a fresh SETUP_SECRET in .env and make sure SETUP_DISABLED=false,
#    then restart
docker compose up -d api
```

Open `/setup` and create the new administrator. Afterwards set
`SETUP_DISABLED=true` and clear `SETUP_SECRET`.

---

## 5. Force-revoke all sessions

```bash
docker compose exec api python - <<'PY'
from datetime import datetime, timezone
from app.database import SessionLocal
from app.models import AuthSession

db = SessionLocal()
count = 0
for session in db.query(AuthSession).filter(AuthSession.revoked_at.is_(None)).all():
    session.revoked_at = datetime.now(timezone.utc)
    count += 1
db.commit()
print("revoked", count, "sessions")
PY
```

---

## 6. Participant cannot register

Work through the checklist in order:

1. **Exam state** — the exam must be `SCHEDULED`, `REGISTRATION_OPEN` or
   `WAITING`, and inside its registration window.
2. **Roster entry exists** — Admin → exam → Roster. The name must be present.
3. **Normalized-name match** — compare the roster row's *Kunci normalisasi*
   column with the participant's input. Only casing/whitespace differences are
   tolerated; typos are not.
4. **Ambiguous roster** — two rows with the same normalized key make
   registration impossible by design. Remove one of them.
5. **Rate limiting** — 20 attempts/minute per IP. Wait a minute or check
   `docker compose logs api`.
6. **Identity mode** — with `PARTICIPANT_IDENTITY_MODE=google`, a missing or
   expired Google ID token returns `401`.

---

## 7. Participant session stuck in `INITIALIZING` / `CONNECTION_LOST`

```bash
docker compose exec api python - <<'PY'
from app.database import SessionLocal
from app.models import ParticipantSession

db = SessionLocal()
ps_id = input("participant_session_id: ").strip()
ps = db.get(ParticipantSession, ps_id)
if ps is None:
    raise SystemExit("not found")
print("status:", ps.status, "| last heartbeat:", ps.last_heartbeat_at)
# Manual recovery: let the participant re-verify the page
ps.status = "INITIALIZING"
db.commit()
print("reset to INITIALIZING")
PY
```

Ask the participant to reload `/join` and complete the readiness steps again.

---

## 8. Exam timer needs a manual correction

Only for genuine operational incidents (documented in the audit log afterwards).

```bash
docker compose exec api python - <<'PY'
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from app.database import SessionLocal
from app.models import Exam, ExamSession

db = SessionLocal()
exam_code = input("exam_code: ").strip().upper()
exam = db.scalar(select(Exam).where(Exam.exam_code == exam_code))
session = db.scalar(
    select(ExamSession).where(ExamSession.exam_id == exam.id).order_by(ExamSession.created_at.desc())
)
extra = int(input("extend by minutes: "))
session.ends_at = session.ends_at + timedelta(minutes=extra)
db.commit()
print("new deadline:", session.ends_at)
PY
```

The expiry worker picks the change up within `EXPIRY_SWEEP_SECONDS`.

---

## 9. Recover from a failed migration

```bash
docker compose exec api alembic current
docker compose exec api alembic history
# roll back one revision
docker compose exec api alembic downgrade -1
# fix forward, then
docker compose exec api alembic upgrade head
```

Always take a `pg_dump` before downgrading.
