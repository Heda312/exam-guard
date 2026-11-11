"""First-run setup and dashboard authentication (spec §3.5, §5.1)."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import record_audit
from ..config import settings
from ..database import get_db
from ..deps import client_ip, get_current_session, get_current_user, require_csrf
from ..models import AppSetting, AuthSession, ExamProctor, User
from ..ratelimit import RateLimitExceeded, SlidingWindowRateLimiter
from ..schemas import (
    ChangePasswordRequest,
    FirstRunSetupRequest,
    LoginRequest,
    MeResponse,
    MessageResponse,
    ProctorPermissions,
    SetupStatus,
    UserOut,
)
from ..security import (
    hash_password,
    hash_token,
    new_csrf_token,
    new_opaque_token,
    session_expiry,
    validate_password_strength,
    verify_password,
    verify_setup_secret,
)

router = APIRouter(tags=["auth"])

login_limiter = SlidingWindowRateLimiter(settings.login_rate_limit_per_minute)
setup_limiter = SlidingWindowRateLimiter(5)

SETUP_COMPLETED_KEY = "setup_completed"


def _setup_completed(db: Session) -> bool:
    if settings.setup_disabled:
        return True
    value = db.get(AppSetting, SETUP_COMPLETED_KEY)
    if value is not None and value.value == "true":
        return True
    # Defensive: if an admin already exists, setup is effectively complete.
    admin_count = db.scalar(select(func.count(User.id)).where(User.role == "ADMIN"))
    return bool(admin_count)


def _set_cookie(response: Response, name: str, value: str, *, http_only: bool, max_age: int) -> None:
    response.set_cookie(
        key=name,
        value=value,
        max_age=max_age,
        httponly=http_only,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,  # type: ignore[arg-type]
        domain=settings.cookie_domain,
        path="/",
    )


def _issue_session(db: Session, request: Request, response: Response, user: User) -> AuthSession:
    token = new_opaque_token()
    csrf = new_csrf_token()
    session = AuthSession(
        user_id=user.id,
        token_hash=hash_token(token),
        csrf_token=csrf,
        user_agent=(request.headers.get("user-agent") or "")[:400] or None,
        ip_address=client_ip(request),
        expires_at=session_expiry(),
    )
    db.add(session)
    max_age = settings.session_ttl_minutes * 60
    _set_cookie(response, settings.session_cookie_name, token, http_only=True, max_age=max_age)
    # CSRF cookie is readable by JS (double-submit pattern).
    _set_cookie(response, settings.csrf_cookie_name, csrf, http_only=False, max_age=max_age)
    return session


def _permissions_for(db: Session, user: User) -> dict:
    if user.role == "ADMIN":
        return {
            "role": "ADMIN",
            "is_admin": True,
            "exams": [],
            "global": {
                "manage_users": True,
                "manage_exams": True,
                "manage_roster": True,
                "review_incidents": True,
                "export_report": True,
                "view_audit": True,
                "manage_settings": True,
            },
        }
    assignments = list(
        db.scalars(select(ExamProctor).where(ExamProctor.proctor_user_id == user.id)).all()
    )
    return {
        "role": "PROCTOR",
        "is_admin": False,
        "exams": [
            {
                "exam_id": item.exam_id,
                "permissions": ProctorPermissions(
                    can_view_exam=item.can_view_exam,
                    can_view_participants=item.can_view_participants,
                    can_start_exam=item.can_start_exam,
                    can_end_exam=item.can_end_exam,
                    can_review_incidents=item.can_review_incidents,
                    can_export_report=item.can_export_report,
                ).model_dump(),
            }
            for item in assignments
        ],
        "global": {
            "manage_users": False,
            "manage_exams": False,
            "manage_roster": False,
            "review_incidents": any(item.can_review_incidents for item in assignments),
            "export_report": any(item.can_export_report for item in assignments),
            "view_audit": False,
            "manage_settings": False,
        },
    }


@router.get("/setup/status", response_model=SetupStatus)
def setup_status(db: Annotated[Session, Depends(get_db)]) -> SetupStatus:
    return SetupStatus(
        setup_required=not _setup_completed(db),
        setup_secret_configured=bool(settings.setup_secret),
    )


@router.post("/setup", response_model=MeResponse, status_code=status.HTTP_201_CREATED)
def first_run_setup(
    payload: FirstRunSetupRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> MeResponse:
    allowed, retry_after = setup_limiter.check(client_ip(request) or "unknown")
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Terlalu banyak percobaan setup.",
            headers={"Retry-After": str(int(retry_after) + 1)},
        )

    if _setup_completed(db):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Setup awal sudah diselesaikan. Gunakan prosedur pemulihan di dokumentasi.",
        )
    if not verify_setup_secret(payload.setup_secret):
        record_audit(db, action="setup.failed", metadata={"reason": "invalid_setup_secret"}, commit=True)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Setup secret tidak valid.")

    try:
        validate_password_strength(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    username = payload.username.strip().lower()
    if db.scalar(select(User).where(User.username == username)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username sudah digunakan.")

    admin = User(
        username=username,
        full_name=payload.full_name.strip(),
        password_hash=hash_password(payload.password),
        role="ADMIN",
        is_active=True,
    )
    db.add(admin)
    db.flush()
    db.merge(AppSetting(key=SETUP_COMPLETED_KEY, value="true"))
    session = _issue_session(db, request, response, admin)
    record_audit(
        db,
        action="setup.completed",
        actor=admin,
        resource_type="user",
        resource_id=admin.id,
        ip_address=client_ip(request),
    )
    db.commit()
    return MeResponse(
        user=UserOut.model_validate(admin),
        csrf_token=session.csrf_token,
        permissions=_permissions_for(db, admin),
    )


@router.post("/auth/login", response_model=MeResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> MeResponse:
    ip = client_ip(request) or "unknown"
    username = payload.username.strip().lower()
    key = f"{ip}:{username}"
    allowed, retry_after = login_limiter.check(key)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Terlalu banyak percobaan masuk. Coba lagi nanti.",
            headers={"Retry-After": str(int(retry_after) + 1)},
        )

    user: Optional[User] = db.scalar(select(User).where(User.username == username))
    if user is None or not verify_password(payload.password, user.password_hash):
        record_audit(
            db,
            action="auth.login_failed",
            actor_label=username,
            metadata={"reason": "invalid_credentials"},
            ip_address=ip,
            commit=True,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Username atau kata sandi salah.")
    if not user.is_active:
        record_audit(
            db,
            action="auth.login_failed",
            actor=user,
            metadata={"reason": "inactive_account"},
            ip_address=ip,
            commit=True,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Akun Anda tidak aktif.")

    session = _issue_session(db, request, response, user)
    user.last_login_at = session.created_at
    login_limiter.reset(key)
    record_audit(
        db,
        action="auth.login_success",
        actor=user,
        metadata={"role": user.role},
        ip_address=ip,
    )
    db.commit()
    return MeResponse(
        user=UserOut.model_validate(user),
        csrf_token=session.csrf_token,
        permissions=_permissions_for(db, user),
    )


@router.get("/auth/me", response_model=MeResponse)
def read_me(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AuthSession, Depends(get_current_session)],
    db: Annotated[Session, Depends(get_db)],
) -> MeResponse:
    return MeResponse(
        user=UserOut.model_validate(user),
        csrf_token=session.csrf_token,
        permissions=_permissions_for(db, user),
    )


@router.post("/auth/logout", response_model=MessageResponse)
def logout(
    response: Response,
    session: Annotated[AuthSession, Depends(get_current_session)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    from ..models import utcnow

    session.revoked_at = utcnow()
    user = db.get(User, session.user_id)
    record_audit(db, action="auth.logout", actor=user)
    db.commit()
    response.delete_cookie(settings.session_cookie_name, path="/", domain=settings.cookie_domain)
    response.delete_cookie(settings.csrf_cookie_name, path="/", domain=settings.cookie_domain)
    return MessageResponse(message="Anda telah keluar.")


@router.post("/auth/change-password", response_model=MessageResponse)
def change_password(
    payload: ChangePasswordRequest,
    user: Annotated[User, Depends(get_current_user)],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Kata sandi saat ini salah.")
    try:
        validate_password_strength(payload.new_password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    record_audit(db, action="auth.password_changed", actor=user, resource_type="user", resource_id=user.id)
    db.commit()
    return MessageResponse(message="Kata sandi berhasil diperbarui.")
