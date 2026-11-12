"""Participant registration and session lifecycle (spec §6, §7, §10, §11, §13)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Exam,
    ExamParticipant,
    ExamSession,
    ParticipantSession,
    utcnow,
)
from ..names import clean_display_name, mask_npm, normalize_name
from ..schemas import ParticipantRegisterRequest
from ..states import ACTIVE_PARTICIPANT_STATUSES, TERMINAL_PARTICIPANT_STATUSES, assert_participant_transition
from .exams import (
    ensure_utc,
    get_active_exam_session,
    get_exam_session_for_exam,
    registration_window_state,
)
from .roster import find_roster_matches

GENERIC_IDENTITY_ERROR = "Identitas tidak dapat diverifikasi. Periksa kembali Exam ID dan nama."


class RegistrationError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "registration_failed") -> None:
        self.message = message
        self.status_code = status_code
        self.code = code
        super().__init__(message)


class CommitmentError(RegistrationError):
    def __init__(self, message: str = "Pernyataan integritas wajib disetujui.") -> None:
        super().__init__(message, status_code=422, code="commitment_required")


def _active_session_for_participant(
    db: Session, exam_id: str, participant_id: str
) -> Optional[ParticipantSession]:
    """Find the participant's session in the *current* exam session."""
    exam_session = get_active_exam_session(db, exam_id)
    if exam_session is None:
        return None
    sessions = list(
        db.scalars(
            select(ParticipantSession)
            .where(
                ParticipantSession.exam_session_id == exam_session.id,
                ParticipantSession.participant_id == participant_id,
            )
            .order_by(ParticipantSession.created_at.desc())
        ).all()
    )
    for session in sessions:
        if session.status in ACTIVE_PARTICIPANT_STATUSES:
            return session
    return sessions[0] if sessions else None


def register_participant(
    db: Session,
    payload: ParticipantRegisterRequest,
    *,
    identity_subject: Optional[str] = None,
    identity_email: Optional[str] = None,
) -> tuple[ParticipantSession, bool]:
    """Run the validation sequence from spec §6.5.

    Returns (participant_session, resumed) where ``resumed`` is True when an
    existing session was reused instead of created.
    """
    # 1. Identity (only enforced when Google mode is enabled).
    if settings.participant_identity_mode == "google" and not identity_subject:
        raise RegistrationError(
            "Autentikasi Google diperlukan sebelum mendaftar ujian.",
            status_code=401,
            code="google_auth_required",
        )

    # 2. Exam ID format + existence.
    exam_code = payload.exam_code.strip().upper()
    exam = db.scalar(select(Exam).where(Exam.exam_code == exam_code))
    if exam is None:
        raise RegistrationError(GENERIC_IDENTITY_ERROR, status_code=404, code="invalid_exam")

    # 3. Registration state.
    allowed, reason = registration_window_state(exam)
    if not allowed:
        raise RegistrationError(reason, status_code=409, code="registration_closed")

    # 4/5. Normalize and match the roster by Exam ID + normalized name only.
    submitted_name = clean_display_name(payload.full_name)
    normalized = normalize_name(submitted_name)
    if not normalized:
        raise RegistrationError(GENERIC_IDENTITY_ERROR, status_code=404, code="invalid_identity")

    matches = find_roster_matches(db, exam.id, normalized)
    if len(matches) != 1:
        # Ambiguous roster or unknown name: same generic message, no enumeration.
        raise RegistrationError(GENERIC_IDENTITY_ERROR, status_code=404, code="invalid_identity")
    roster_entry: ExamParticipant = matches[0]

    # 7. Commitment must be independently validated by the API.
    if not payload.commitment_accepted:
        raise CommitmentError()
    if payload.commitment_version and payload.commitment_version != settings.commitment_version:
        raise CommitmentError(
            "Versi pernyataan integritas tidak sesuai. Muat ulang halaman dan setujui kembali."
        )

    # 8. NPM is optional informational data only.
    reported_npm = payload.npm.strip() if payload.npm and payload.npm.strip() else None

    exam_session = get_exam_session_for_exam(db, exam)
    existing = _active_session_for_participant(db, exam.id, roster_entry.participant_id)

    if existing is not None and existing.status not in TERMINAL_PARTICIPANT_STATUSES:
        # 9b. Resume instead of creating a duplicate active session.
        if reported_npm and not existing.npm_reported:
            existing.npm_reported = reported_npm
        if not existing.commitment_accepted:
            existing.commitment_accepted = True
            existing.commitment_version = settings.commitment_version
            existing.commitment_accepted_at = utcnow()
        _promote_to_waiting_if_needed(existing, exam_session)
        db.flush()
        return existing, True

    if existing is not None and existing.status in TERMINAL_PARTICIPANT_STATUSES:
        # Terminal sessions are not reusable for a fresh registration.
        raise RegistrationError(
            "Sesi ujian Anda untuk ujian ini telah berakhir.", status_code=409, code="session_ended"
        )

    participant_session = ParticipantSession(
        exam_session_id=exam_session.id,
        participant_id=roster_entry.participant_id,
        status="REGISTERED",
        commitment_accepted=True,
        commitment_version=settings.commitment_version,
        # Server-generated timestamp; any client value is ignored.
        commitment_accepted_at=utcnow(),
        npm_reported=reported_npm,
        connected_at=utcnow(),
    )
    db.add(participant_session)
    db.flush()
    _promote_to_waiting_if_needed(participant_session, exam_session)
    db.flush()
    return participant_session, False


def _promote_to_waiting_if_needed(session: ParticipantSession, exam_session: ExamSession) -> None:
    if exam_session.status == "LIVE":
        if session.status in {"REGISTERED", "WAITING", "CONNECTION_LOST"}:
            session.status = "INITIALIZING"
        return
    if session.status == "REGISTERED":
        session.status = "WAITING"


def mark_ready(
    db: Session, participant_session: ParticipantSession, page_url: Optional[str] = None
) -> ParticipantSession:
    """Participant reports that the exam page is loaded and verified (spec §11.2).

    ``WAITING`` and ``REGISTERED`` are accepted too: a participant who registers
    while the exam is already LIVE lands in WAITING (or REGISTERED when the exam
    session was created lazily), and refusing them here is what made the
    "Buka ujian" button fail silently for late arrivals.
    """
    exam_session = db.get(ExamSession, participant_session.exam_session_id)
    if exam_session is None or exam_session.status != "LIVE":
        raise RegistrationError("Ujian belum dimulai.", status_code=409, code="exam_not_live")

    if participant_session.status in {"READY", "MONITORING"}:
        return participant_session
    if participant_session.status not in {
        "INITIALIZING",
        "CONNECTION_LOST",
        "REGISTERED",
        "WAITING",
    }:
        raise RegistrationError(
            "Status sesi tidak memungkinkan verifikasi kesiapan.", status_code=409, code="invalid_state"
        )
    # Jump straight to READY: the intermediate states are bookkeeping, not a
    # gate the participant has to pass through.
    participant_session.status = "READY"
    db.flush()
    return participant_session


def start_monitoring(db: Session, participant_session: ParticipantSession) -> ParticipantSession:
    if participant_session.status == "MONITORING":
        return participant_session
    if participant_session.status not in {"READY"}:
        # Spec: never enter MONITORING before the exam tab is verified.
        raise RegistrationError(
            "Halaman ujian belum terverifikasi. Monitoring belum dapat dimulai.",
            status_code=409,
            code="page_not_ready",
        )
    assert_participant_transition(participant_session.status, "MONITORING")
    participant_session.status = "MONITORING"
    participant_session.connected_at = participant_session.connected_at or utcnow()
    db.flush()
    return participant_session


def record_heartbeat(db: Session, participant_session: ParticipantSession) -> ParticipantSession:
    now = utcnow()
    participant_session.last_heartbeat_at = now
    if participant_session.status == "CONNECTION_LOST":
        exam_session = db.get(ExamSession, participant_session.exam_session_id)
        target = "MONITORING" if exam_session and exam_session.status == "LIVE" else "WAITING"
        if participant_session.completed_at is not None:
            return participant_session
        participant_session.status = target
        participant_session.connected_at = now
        participant_session.disconnected_at = None
    elif participant_session.status in {"REGISTERED", "WAITING", "INITIALIZING"}:
        participant_session.connected_at = participant_session.connected_at or now
    db.flush()
    return participant_session


def mark_connection_lost(db: Session, participant_session: ParticipantSession) -> None:
    if participant_session.status in TERMINAL_PARTICIPANT_STATUSES:
        return
    if participant_session.status == "CONNECTION_LOST":
        return
    now = utcnow()
    participant_session.status = "CONNECTION_LOST"
    participant_session.disconnected_at = now
    db.flush()


def record_reconnect(db: Session, participant_session: ParticipantSession) -> ParticipantSession:
    """Synchronise after reconnect without touching the official deadline."""
    now = utcnow()
    if participant_session.disconnected_at is not None:
        disconnected_at = ensure_utc(participant_session.disconnected_at) or now
        delta = int((now - disconnected_at).total_seconds())
        if delta > 0:
            participant_session.connection_lost_seconds += delta
    participant_session.disconnected_at = None
    participant_session.connected_at = now
    participant_session.last_heartbeat_at = now
    exam_session = db.get(ExamSession, participant_session.exam_session_id)
    if participant_session.status == "CONNECTION_LOST":
        participant_session.status = (
            "MONITORING" if exam_session and exam_session.status == "LIVE" else "WAITING"
        )
    db.flush()
    return participant_session


def is_online(participant_session: ParticipantSession, now: Optional[datetime] = None) -> bool:
    now = now or utcnow()
    if participant_session.status == "CONNECTION_LOST":
        return False
    last = ensure_utc(participant_session.last_heartbeat_at) or ensure_utc(participant_session.connected_at)
    if last is None:
        return False
    return (now - last).total_seconds() <= settings.heartbeat_timeout_seconds


def participant_payload(
    db: Session, participant_session: ParticipantSession, *, include_form_url: bool = False
) -> dict:
    from .exams import time_remaining_seconds

    exam_session = db.get(ExamSession, participant_session.exam_session_id)
    exam = db.get(Exam, exam_session.exam_id) if exam_session else None
    roster = db.scalar(
        select(ExamParticipant).where(
            ExamParticipant.exam_id == exam.id,
            ExamParticipant.participant_id == participant_session.participant_id,
        )
    ) if exam else None
    participant = participant_session.participant

    messages: list[str] = []
    if participant_session.status == "CONNECTION_LOST":
        messages.append("Koneksi terputus. Waktu ujian tetap berjalan. Sambungkan kembali perangkat Anda.")

    return {
        "participant_session_id": participant_session.id,
        "exam_id": exam.id if exam else "",
        "exam_code": exam.exam_code if exam else "",
        "exam_name": exam.name if exam else "",
        "exam_status": exam.status if exam else "UNKNOWN",
        "participant": {
            "full_name": participant.full_name,
            # Masked for participant-facing display (spec §10.2).
            "npm": mask_npm(participant.npm),
            "group_name": roster.group_name if roster else None,
        },
        "status": participant_session.status,
        "connection_state": "ONLINE" if is_online(participant_session) else "OFFLINE",
        "commitment": {
            "accepted": participant_session.commitment_accepted,
            "version": participant_session.commitment_version,
            "accepted_at": participant_session.commitment_accepted_at,
        },
        "started_at": exam_session.started_at if exam_session else None,
        "ends_at": exam_session.ends_at if exam_session else None,
        "server_time": utcnow(),
        "google_forms_url": (exam.google_forms_url if exam and include_form_url else None),
        "heartbeat_interval_seconds": settings.heartbeat_interval_seconds,
        "messages": messages,
    }
