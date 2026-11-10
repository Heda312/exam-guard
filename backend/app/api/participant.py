"""Participant-facing endpoints: registration, session state, heartbeat, events.

Participants are *not* dashboard users. After a successful roster match the API
issues an opaque participant token scoped to exactly one participant session
(spec §11, §13, §14). Only the token hash is persisted.
"""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import record_audit
from ..config import settings
from ..database import get_db
from ..deps import client_ip
from ..models import Exam, ExamSession, ParticipantSession, utcnow
from ..ratelimit import SlidingWindowRateLimiter
from ..schemas import (
    MessageResponse,
    MonitoringEventIn,
    MonitoringEventOut,
    ParticipantRegisterRequest,
    ParticipantSessionOut,
    ReadyRequest,
    ReconnectRequest,
)
from ..security import constant_time_equals, hash_token, new_opaque_token
from ..services.exams import registration_window_state, time_remaining_seconds
from ..services.identity import IdentityError, google_auth_required, verify_google_id_token
from ..services.monitoring import record_event
from ..services.participants import (
    RegistrationError,
    mark_connection_lost,
    mark_ready,
    participant_payload,
    record_heartbeat,
    record_reconnect,
    register_participant,
    start_monitoring,
)
from ..ws import envelope, manager

router = APIRouter(prefix="/participant", tags=["participant"])

register_limiter = SlidingWindowRateLimiter(settings.register_rate_limit_per_minute)

ParticipantToken = Annotated[Optional[str], Header(alias="X-Participant-Token")]
Db = Annotated[Session, Depends(get_db)]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _participant_session_or_404(db: Session, participant_session_id: str) -> ParticipantSession:
    ps = db.get(ParticipantSession, participant_session_id)
    if ps is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sesi peserta tidak ditemukan.")
    return ps


def _issue_participant_token(db: Session, ps: ParticipantSession) -> str:
    """Rotate and persist a new opaque token; only the hash is stored."""
    token = new_opaque_token(24)
    ps.access_token_hash = hash_token(token)
    db.flush()
    return token


def _authorize(db: Session, participant_session_id: str, token: Optional[str]) -> ParticipantSession:
    ps = _participant_session_or_404(db, participant_session_id)
    if not ps.access_token_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesi peserta tidak dikenal. Silakan daftar ulang.",
        )
    if not token or not constant_time_equals(hash_token(token), ps.access_token_hash):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Token peserta tidak valid.")
    return ps


def _session_out(db: Session, ps: ParticipantSession) -> ParticipantSessionOut:
    payload = participant_payload(db, ps, include_form_url=True)
    exam_session = db.get(ExamSession, ps.exam_session_id)
    messages: list[str] = []
    if ps.status == "CONNECTION_LOST":
        messages.append("Koneksi terputus. Waktu ujian tetap berjalan.")
    if exam_session is not None and exam_session.ends_at is not None and time_remaining_seconds(exam_session) == 0:
        messages.append("Waktu ujian telah berakhir.")
    payload["messages"] = messages
    return ParticipantSessionOut(**payload)


# ---------------------------------------------------------------------------
# Public metadata
# ---------------------------------------------------------------------------
@router.get("/config")
def participant_config() -> dict:
    return {
        "google_auth_required": google_auth_required(),
        "commitment_version": settings.commitment_version,
        "heartbeat_interval_seconds": settings.heartbeat_interval_seconds,
        "google_client_id": settings.google_client_id if google_auth_required() else None,
        "integrity_commitment": (
            "Saya menyatakan bahwa saya mengerjakan ujian ini secara jujur dan mandiri, "
            "tidak menggunakan bantuan pihak lain, tidak membuka sumber yang tidak diizinkan, "
            "serta memahami bahwa aktivitas browser saya selama ujian dipantau dan dicatat."
        ),
    }


@router.get("/exam/{exam_code}/public")
def public_exam_info(exam_code: str, db: Db) -> dict:
    """Minimal exam metadata for the registration page.

    Deliberately exposes no roster information (spec §6.2).
    """
    exam = db.scalar(select(Exam).where(Exam.exam_code == exam_code.strip().upper()))
    if exam is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exam ID tidak ditemukan.")
    allowed, reason = registration_window_state(exam)
    return {
        "exam_code": exam.exam_code,
        "name": exam.name,
        "status": exam.status,
        "duration_minutes": exam.duration_minutes,
        "registration_open": allowed,
        "registration_message": reason or None,
        "scheduled_at": exam.scheduled_at,
        "server_time": utcnow(),
    }


# ---------------------------------------------------------------------------
# Registration and session lifecycle
# ---------------------------------------------------------------------------
@router.post("/register", response_model=ParticipantSessionOut, status_code=status.HTTP_201_CREATED)
def register(
    payload: ParticipantRegisterRequest,
    request: Request,
    response: Response,
    db: Db,
) -> ParticipantSessionOut:
    ip = client_ip(request) or "unknown"
    allowed, retry_after = register_limiter.check(ip)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Terlalu banyak percobaan pendaftaran. Coba lagi nanti.",
            headers={"Retry-After": str(int(retry_after) + 1)},
        )

    identity = None
    if google_auth_required():
        try:
            identity = verify_google_id_token(payload.google_id_token or "")
        except IdentityError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    try:
        ps, resumed = register_participant(
            db,
            payload,
            identity_subject=identity.subject if identity else None,
            identity_email=identity.email if identity else None,
        )
    except RegistrationError as exc:
        db.rollback()
        record_audit(
            db,
            action="participant.registration_failed",
            actor_label=payload.full_name,
            metadata={"exam_code": payload.exam_code.upper(), "reason": exc.code},
            ip_address=ip,
            commit=True,
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    token = _issue_participant_token(db, ps)
    record_audit(
        db,
        action="participant.registered",
        resource_type="participant_session",
        resource_id=ps.id,
        metadata={"exam_code": payload.exam_code.upper(), "resumed": resumed},
        ip_address=ip,
    )
    db.commit()
    response.headers["X-Participant-Token"] = token
    return _session_out(db, ps)


@router.post("/session", response_model=ParticipantSessionOut)
def resume_session(payload: ReconnectRequest, db: Db, token: ParticipantToken = None) -> ParticipantSessionOut:
    ps = _authorize(db, payload.participant_session_id, token)
    if ps.status not in {"COMPLETED", "TIME_EXPIRED", "CANCELLED"}:
        record_reconnect(db, ps)
        db.commit()
    return _session_out(db, ps)


@router.get("/session/{participant_session_id}", response_model=ParticipantSessionOut)
def get_session(participant_session_id: str, db: Db, token: ParticipantToken = None) -> ParticipantSessionOut:
    ps = _authorize(db, participant_session_id, token)
    return _session_out(db, ps)


@router.post("/heartbeat", response_model=MessageResponse)
async def heartbeat(payload: ReconnectRequest, db: Db, token: ParticipantToken = None) -> MessageResponse:
    ps = _authorize(db, payload.participant_session_id, token)
    record_heartbeat(db, ps)
    db.commit()

    exam_session = db.get(ExamSession, ps.exam_session_id)
    remaining = time_remaining_seconds(exam_session) if exam_session else 0
    if exam_session and remaining == 0 and ps.status not in {"COMPLETED", "TIME_EXPIRED"}:
        await manager.send_to_participant(ps.id, envelope("time_expired", {"participant_session_id": ps.id}))
    return MessageResponse(message=f"ok:{remaining}")


@router.post("/ready", response_model=ParticipantSessionOut)
async def ready(payload: ReadyRequest, db: Db, token: ParticipantToken = None) -> ParticipantSessionOut:
    ps = _authorize(db, payload.participant_session_id, token)
    try:
        mark_ready(db, ps, payload.page_url)
    except RegistrationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    db.commit()

    exam_session = db.get(ExamSession, ps.exam_session_id)
    if exam_session is not None:
        await manager.send_to_exam(
            exam_session.id,
            envelope("participant_ready", {"participant_session_id": ps.id, "status": ps.status}),
        )
    return _session_out(db, ps)


@router.post("/monitoring/start", response_model=ParticipantSessionOut)
async def begin_monitoring(payload: ReconnectRequest, db: Db, token: ParticipantToken = None) -> ParticipantSessionOut:
    ps = _authorize(db, payload.participant_session_id, token)
    try:
        start_monitoring(db, ps)
    except RegistrationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    db.commit()

    exam_session = db.get(ExamSession, ps.exam_session_id)
    if exam_session is not None:
        await manager.send_to_exam(
            exam_session.id,
            envelope(
                "participant_monitoring_started",
                {"participant_session_id": ps.id, "status": ps.status},
            ),
        )
    return _session_out(db, ps)


@router.post("/disconnect", response_model=MessageResponse)
async def disconnect(payload: ReconnectRequest, db: Db, token: ParticipantToken = None) -> MessageResponse:
    ps = _authorize(db, payload.participant_session_id, token)
    mark_connection_lost(db, ps)
    db.commit()

    exam_session = db.get(ExamSession, ps.exam_session_id)
    if exam_session is not None:
        await manager.send_to_exam(
            exam_session.id,
            envelope("participant_connection_lost", {"participant_session_id": ps.id, "status": ps.status}),
        )
    return MessageResponse(message="Koneksi ditandai terputus.")


# ---------------------------------------------------------------------------
# Monitoring event ingestion
# ---------------------------------------------------------------------------
@router.post("/events", response_model=list[MonitoringEventOut], status_code=status.HTTP_201_CREATED)
async def submit_events(
    events: list[MonitoringEventIn],
    participant_session_id: str,
    db: Db,
    token: ParticipantToken = None,
) -> list[MonitoringEventOut]:
    """Batch ingest from the extension. Monitoring must already be active."""
    if not events:
        return []
    if len(events) > 50:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Maksimal 50 event per batch.",
        )

    ps = _authorize(db, participant_session_id, token)
    if ps.status != "MONITORING":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Monitoring belum aktif untuk sesi ini.")
    exam_session = db.get(ExamSession, ps.exam_session_id)
    if exam_session is None or exam_session.status != "LIVE":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Ujian tidak sedang berlangsung.")

    stored: list[MonitoringEventOut] = []
    for item in events:
        event, incident = record_event(db, ps, item)
        stored.append(MonitoringEventOut.model_validate(event))
        await manager.send_to_exam(
            exam_session.id,
            envelope(
                "monitoring_event",
                {
                    "participant_session_id": ps.id,
                    "event_type": event.event_type,
                    "received_at": event.received_at,
                    "page_host": event.page_host,
                },
            ),
        )
        if incident is not None:
            await manager.send_to_exam(
                exam_session.id,
                envelope(
                    "incident_created",
                    {
                        "incident_id": incident.id,
                        "participant_session_id": ps.id,
                        "incident_type": incident.incident_type,
                        "event_count": incident.event_count,
                    },
                ),
            )
    db.commit()
    return stored
