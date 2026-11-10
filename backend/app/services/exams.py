"""Exam lifecycle, timer and Google Forms URL validation (spec §8, §12)."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Exam, ExamSession, ParticipantSession, utcnow
from ..states import (
    InvalidTransition,
    assert_exam_transition,
    TERMINAL_PARTICIPANT_STATUSES,
)

EXAM_CODE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9\-_]{2,63}$")


class ExamValidationError(Exception):
    def __init__(self, message: str, field: str = "exam") -> None:
        self.message = message
        self.field = field
        super().__init__(message)


def validate_exam_code(code: str) -> str:
    normalized = (code or "").strip().upper()
    if not EXAM_CODE_PATTERN.match(normalized):
        raise ExamValidationError(
            "Exam ID harus 3-64 karakter, hanya huruf, angka, tanda hubung atau garis bawah.",
            field="exam_code",
        )
    return normalized


def generate_exam_code(db: Session, year: Optional[int] = None) -> str:
    year = year or datetime.now(timezone.utc).year
    prefix = f"EXG-{year}-"
    existing = db.scalars(select(Exam.exam_code).where(Exam.exam_code.like(f"{prefix}%"))).all()
    highest = 0
    for code in existing:
        tail = code[len(prefix):]
        if tail.isdigit():
            highest = max(highest, int(tail))
    return f"{prefix}{highest + 1:03d}"


def validate_google_forms_url(url: str | None) -> str | None:
    """Require HTTPS on an allow-listed exam host (spec §8.3)."""
    if url is None or not url.strip():
        return None
    candidate = url.strip()
    parsed = urlparse(candidate)
    if parsed.scheme.lower() != "https":
        raise ExamValidationError("URL formulir ujian wajib menggunakan HTTPS.", field="google_forms_url")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ExamValidationError("URL formulir ujian tidak valid.", field="google_forms_url")
    allowed = settings.allowed_exam_hosts
    if not any(host == item or host.endswith("." + item) for item in allowed):
        raise ExamValidationError(
            "URL formulir harus berasal dari domain yang diizinkan (mis. docs.google.com).",
            field="google_forms_url",
        )
    if parsed.username or parsed.password:
        raise ExamValidationError("URL formulir tidak boleh memuat kredensial.", field="google_forms_url")
    return candidate


def ensure_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def registration_window_state(exam: Exam, now: Optional[datetime] = None) -> tuple[bool, str]:
    """Return (allowed, reason)."""
    now = now or utcnow()
    if exam.status in {"COMPLETED", "CANCELLED"}:
        return False, "Ujian telah berakhir."
    if exam.status == "DRAFT":
        return False, "Pendaftaran untuk ujian ini belum dibuka."
    if exam.status in {"STARTING", "LIVE"}:
        return False, "Ujian sudah dimulai."
    opens = ensure_utc(exam.registration_opens_at)
    closes = ensure_utc(exam.registration_closes_at)
    if opens and now < opens:
        return False, "Pendaftaran untuk ujian ini belum dibuka."
    if closes and now > closes:
        return False, "Pendaftaran untuk ujian ini telah ditutup."
    if exam.status not in {"REGISTRATION_OPEN", "WAITING", "SCHEDULED"}:
        return False, "Pendaftaran untuk ujian ini belum dibuka."
    return True, ""


def get_active_exam_session(db: Session, exam_id: str) -> Optional[ExamSession]:
    return db.scalar(
        select(ExamSession)
        .where(ExamSession.exam_id == exam_id)
        .order_by(ExamSession.created_at.desc())
    )


def get_exam_session_for_exam(db: Session, exam: Exam) -> ExamSession:
    """Return the current exam session, creating one lazily during registration."""
    return get_or_create_exam_session(db, exam)


def get_or_create_exam_session(db: Session, exam: Exam) -> ExamSession:
    session = get_active_exam_session(db, exam.id)
    if session is not None:
        return session
    session = ExamSession(exam_id=exam.id, status="WAITING")
    db.add(session)
    db.flush()
    return session


def start_exam(db: Session, exam: Exam, actor_id: str) -> tuple[ExamSession, list[ParticipantSession]]:
    """Start the exam and produce the authoritative timer window."""
    if exam.status in {"COMPLETED", "CANCELLED"}:
        raise ExamValidationError("Ujian tidak dapat dimulai karena sudah selesai/dibatalkan.")
    if exam.status == "LIVE":
        raise ExamValidationError("Ujian sudah berjalan.")
    if not exam.google_forms_url:
        raise ExamValidationError("URL formulir ujian belum diatur.")

    now = utcnow()
    session = get_or_create_exam_session(db, exam)
    if session.started_at is None:
        session.started_at = now
        session.ends_at = now + timedelta(minutes=exam.duration_minutes)
        session.started_by = actor_id
    session.status = "LIVE"

    try:
        assert_exam_transition(exam.status, "STARTING")
    except InvalidTransition:
        pass  # e.g. re-start from WAITING after a recovery flow; audit records it.
    exam.status = "LIVE"

    participant_sessions = list(
        db.scalars(
            select(ParticipantSession).where(
                ParticipantSession.exam_session_id == session.id,
                ParticipantSession.status.in_(["REGISTERED", "WAITING", "CONNECTION_LOST"]),
            )
        ).all()
    )
    for ps in participant_sessions:
        if ps.status in {"REGISTERED", "WAITING", "CONNECTION_LOST"}:
            ps.status = "INITIALIZING"
    db.flush()
    return session, participant_sessions


def end_exam(db: Session, exam: Exam, actor_id: str, status: str = "COMPLETED") -> tuple[ExamSession, list[ParticipantSession]]:
    now = utcnow()
    session = get_active_exam_session(db, exam.id)
    if session is None:
        raise ExamValidationError("Sesi ujian belum dimulai.")
    if session.completed_at is not None:
        raise ExamValidationError("Ujian sudah diakhiri.")

    session.completed_at = now
    session.ended_by = actor_id
    session.status = status
    if exam.status not in {"COMPLETED", "CANCELLED"}:
        exam.status = "COMPLETED"

    participants = list(
        db.scalars(select(ParticipantSession).where(ParticipantSession.exam_session_id == session.id)).all()
    )
    for ps in participants:
        if ps.status not in TERMINAL_PARTICIPANT_STATUSES:
            ps.status = "COMPLETED"
            ps.completed_at = now
    db.flush()
    return session, participants


def expire_exam_session(db: Session, session: ExamSession) -> list[ParticipantSession]:
    """Mark a session and its live participants as TIME_EXPIRED."""
    now = utcnow()
    session.status = "COMPLETED"
    if session.completed_at is None:
        session.completed_at = now
    exam = db.get(Exam, session.exam_id)
    if exam is not None and exam.status not in {"COMPLETED", "CANCELLED"}:
        exam.status = "COMPLETED"

    participants = list(
        db.scalars(select(ParticipantSession).where(ParticipantSession.exam_session_id == session.id)).all()
    )
    changed: list[ParticipantSession] = []
    for ps in participants:
        if ps.status not in TERMINAL_PARTICIPANT_STATUSES:
            ps.status = "TIME_EXPIRED"
            ps.completed_at = now
            changed.append(ps)
    db.flush()
    return changed


def find_expired_sessions(db: Session, now: Optional[datetime] = None) -> list[ExamSession]:
    now = now or utcnow()
    rows = db.scalars(
        select(ExamSession).where(
            ExamSession.ends_at.is_not(None),
            ExamSession.ends_at <= now,
            ExamSession.completed_at.is_(None),
        )
    ).all()
    return list(rows)


def time_remaining_seconds(session: ExamSession, now: Optional[datetime] = None) -> int:
    if session.ends_at is None:
        return 0
    now = now or utcnow()
    ends_at = ensure_utc(session.ends_at)
    return max(0, int((ends_at - now).total_seconds()))
