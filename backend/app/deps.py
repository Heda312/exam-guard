"""FastAPI dependencies: current user, RBAC and proctor exam authorization."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .models import AuthSession, Exam, ExamProctor, User
from .security import constant_time_equals, hash_token


def _client_ip(request: Request) -> Optional[str]:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


def get_current_session(
    db: Annotated[Session, Depends(get_db)],
    session_token: Annotated[Optional[str], Cookie(alias=settings.session_cookie_name)] = None,
) -> AuthSession:
    if not session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesi tidak ditemukan. Silakan masuk.")
    token_hash = hash_token(session_token)
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash))
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesi tidak valid.")
    if session.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesi telah dicabut.")
    expires_at = session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesi telah berakhir.")
    return session


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    session: Annotated[AuthSession, Depends(get_current_session)],
) -> User:
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Akun tidak aktif.")
    return user


def require_csrf(
    request: Request,
    session: Annotated[AuthSession, Depends(get_current_session)],
    csrf_header: Annotated[Optional[str], Header(alias=settings.csrf_header_name)] = None,
) -> None:
    """Double-submit CSRF check for cookie-authenticated state changes."""
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    if not constant_time_equals(csrf_header, session.csrf_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token CSRF tidak valid. Muat ulang halaman.",
        )


def get_admin(
    user: Annotated[User, Depends(get_current_user)],
    _: Annotated[None, Depends(require_csrf)],
) -> User:
    if user.role != "ADMIN":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Akses hanya untuk administrator.")
    return user


def get_dashboard_user(
    user: Annotated[User, Depends(get_current_user)],
    _: Annotated[None, Depends(require_csrf)],
) -> User:
    if user.role not in {"ADMIN", "PROCTOR"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Akses ditolak.")
    return user


def get_exam_or_404(db: Session, exam_id: str) -> Exam:
    exam = db.get(Exam, exam_id)
    if exam is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ujian tidak ditemukan.")
    return exam


def get_exam_by_code(db: Session, exam_code: str) -> Optional[Exam]:
    return db.scalar(select(Exam).where(Exam.exam_code == exam_code.strip().upper()))


def require_exam_access(db: Session, user: User, exam_id: str, permission: str) -> ExamProctor | None:
    """Return the proctor assignment, enforcing exam assignment + permission.

    Admins bypass the assignment check but never the existence check.
    """
    exam = get_exam_or_404(db, exam_id)
    if user.role == "ADMIN":
        return None
    if user.role != "PROCTOR":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Akses ditolak.")

    assignment = db.scalar(
        select(ExamProctor).where(
            ExamProctor.exam_id == exam_id,
            ExamProctor.proctor_user_id == user.id,
        )
    )
    if assignment is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ujian ini tidak ditugaskan kepada Anda.")
    if not getattr(assignment, permission, False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Anda tidak memiliki izin untuk aksi ini.")
    return assignment


CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser = Annotated[User, Depends(get_admin)]
DashboardUser = Annotated[User, Depends(get_dashboard_user)]
DbSession = Annotated[Session, Depends(get_db)]

__all__ = [
    "CurrentUser",
    "AdminUser",
    "DashboardUser",
    "DbSession",
    "get_current_session",
    "get_current_user",
    "require_csrf",
    "get_admin",
    "get_dashboard_user",
    "get_exam_or_404",
    "get_exam_by_code",
    "require_exam_access",
    "client_ip",
]

client_ip = _client_ip
