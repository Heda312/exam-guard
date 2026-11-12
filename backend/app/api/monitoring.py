"""Monitoring dashboard: participant cards, incidents, live state (spec §16, §17)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import record_audit
from ..config import settings
from ..database import get_db
from ..deps import DashboardUser, client_ip, get_exam_or_404, require_exam_access
from ..models import (
    Exam,
    ExamParticipant,
    ExamProctor,
    ExamSession,
    MonitoringEvent,
    ParticipantSession,
    User,
    ViolationIncident,
    utcnow,
)
from ..schemas import (
    AuditLogOut,
    IncidentOut,
    IncidentReviewRequest,
    MonitoringEventOut,
    MonitoringStateOut,
    MonitoringTimerOut,
    OverviewStats,
    ParticipantCard,
    ParticipantDetail,
)
from ..services.exams import (
    ensure_utc,
    get_active_exam_session,
    is_late_join,
    time_remaining_seconds,
)
from ..services.monitoring import (
    EVENT_SUMMARIES,
    incident_context_map,
    incident_counts_for_exam_session,
    latest_event_map,
    latest_event_summary,
    latest_incident_map,
)
from ..services.participants import is_online
from ..ws import envelope, manager

router = APIRouter(tags=["monitoring"])


def _roster_map(db: Session, exam_id: str) -> dict[str, ExamParticipant]:
    links = db.scalars(select(ExamParticipant).where(ExamParticipant.exam_id == exam_id)).all()
    return {link.participant_id: link for link in links}


def _build_card(
    db: Session,
    ps: ParticipantSession,
    roster: dict[str, ExamParticipant],
    incidents: dict[str, int],
    *,
    latest_event: Optional[tuple[Optional[str], Optional[datetime]]] = None,
    latest_incident: Optional[ViolationIncident] = None,
    exam_session: Optional[ExamSession] = None,
) -> ParticipantCard:
    link = roster.get(ps.participant_id)
    summary, last_activity = (
        latest_event if latest_event is not None else latest_event_summary(db, ps.id)
    )
    online = is_online(ps)
    return ParticipantCard(
        participant_session_id=ps.id,
        participant_id=ps.participant_id,
        full_name=ps.participant.full_name,
        npm=ps.participant.npm,
        group_name=link.group_name if link else None,
        status=ps.status,
        connection_state="ONLINE" if online else "OFFLINE",
        online=online,
        incident_count=incidents.get(ps.id, 0),
        last_incident_at=ensure_utc(latest_incident.started_at) if latest_incident else None,
        last_incident_type=latest_incident.incident_type if latest_incident else None,
        last_activity_at=last_activity,
        latest_event_summary=summary,
        last_heartbeat_at=ensure_utc(ps.last_heartbeat_at),
        connected_at=ensure_utc(ps.connected_at),
        is_late=is_late_join(exam_session, ps) if exam_session is not None else False,
        joined_at=ensure_utc(ps.created_at),
    )


def _card_sort_key(card: ParticipantCard) -> tuple:
    return (not card.online, -card.incident_count, card.full_name.lower())


def _timer_payload(exam: Exam, exam_session: Optional[ExamSession]) -> MonitoringTimerOut:
    now = utcnow()
    if exam_session is None:
        return MonitoringTimerOut(
            exam_id=exam.id,
            status=exam.status,
            server_time=now,
            remaining_seconds=0,
        )
    return MonitoringTimerOut(
        exam_id=exam.id,
        exam_session_id=exam_session.id,
        status=exam.status,
        session_status=exam_session.status,
        server_time=now,
        started_at=ensure_utc(exam_session.started_at),
        ends_at=ensure_utc(exam_session.ends_at),
        remaining_seconds=time_remaining_seconds(exam_session, now),
    )


def _cards_for_exam_session(
    db: Session, exam: Exam, exam_session: ExamSession
) -> list[ParticipantCard]:
    """Build every card with a fixed number of queries (no N+1 per participant)."""
    sessions = list(
        db.scalars(
            select(ParticipantSession)
            .where(ParticipantSession.exam_session_id == exam_session.id)
            .order_by(ParticipantSession.created_at)
        ).all()
    )
    if not sessions:
        return []

    roster = _roster_map(db, exam.id)
    incident_counts = incident_counts_for_exam_session(db, exam_session.id)
    latest_events = latest_event_map(db, [ps.id for ps in sessions])
    latest_incidents = latest_incident_map(db, exam_session.id)

    cards = [
        _build_card(
            db,
            ps,
            roster,
            incident_counts,
            latest_event=latest_events.get(ps.id, (None, None)),
            latest_incident=latest_incidents.get(ps.id),
            exam_session=exam_session,
        )
        for ps in sessions
    ]
    cards.sort(key=_card_sort_key)
    return cards


def _incidents_for_exam_session(db: Session, exam_session_id: str) -> list[IncidentOut]:
    """Incidents for an exam session, enriched with host and participant name."""
    incidents = list(
        db.scalars(
            select(ViolationIncident)
            .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
            .where(ParticipantSession.exam_session_id == exam_session_id)
            .order_by(ViolationIncident.started_at.desc())
        ).all()
    )
    context = incident_context_map(db, [incident.id for incident in incidents])
    enriched: list[IncidentOut] = []
    for incident in incidents:
        payload = IncidentOut.model_validate(incident)
        host, name = context.get(incident.id, (None, None))
        payload.page_host = host
        payload.participant_name = name
        enriched.append(payload)
    return enriched


@router.get("/dashboard/overview", response_model=OverviewStats)
def overview(user: DashboardUser, db: Annotated[Session, Depends(get_db)]) -> OverviewStats:
    if user.role == "ADMIN":
        exams = list(db.scalars(select(Exam)).all())
        exam_ids = [exam.id for exam in exams]
    else:
        exam_ids = list(
            db.scalars(
                select(ExamProctor.exam_id).where(
                    ExamProctor.proctor_user_id == user.id, ExamProctor.can_view_exam.is_(True)
                )
            ).all()
        )
        exams = list(db.scalars(select(Exam).where(Exam.id.in_(exam_ids)).all()) if exam_ids else [])

    active_statuses = {"REGISTRATION_OPEN", "WAITING", "STARTING", "LIVE"}
    active_exams = [exam for exam in exams if exam.status in active_statuses]
    active_exam_ids = [exam.id for exam in active_exams]

    session_ids = list(
        db.scalars(select(ExamSession.id).where(ExamSession.exam_id.in_(active_exam_ids))).all()
    ) if active_exam_ids else []

    participant_sessions = list(
        db.scalars(
            select(ParticipantSession).where(
                ParticipantSession.exam_session_id.in_(session_ids),
                ParticipantSession.status.notin_(["COMPLETED", "TIME_EXPIRED", "CANCELLED"]),
            )
        ).all()
    ) if session_ids else []

    online = sum(1 for ps in participant_sessions if is_online(ps))

    incident_count = 0
    unreviewed = 0
    if session_ids:
        incident_count = int(
            db.scalar(
                select(func.count(ViolationIncident.id))
                .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
                .where(ParticipantSession.exam_session_id.in_(session_ids))
            )
            or 0
        )
        unreviewed = int(
            db.scalar(
                select(func.count(ViolationIncident.id))
                .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
                .where(
                    ParticipantSession.exam_session_id.in_(session_ids),
                    ViolationIncident.review_status == "UNREVIEWED",
                )
            )
            or 0
        )

    total_participants = int(
        db.scalar(
            select(func.count(ExamParticipant.id)).where(ExamParticipant.exam_id.in_(exam_ids))
        )
        or 0
    ) if exam_ids else 0

    return OverviewStats(
        total_exams=len(exams),
        active_exams=len(active_exams),
        total_participants=total_participants,
        online_participants=online,
        offline_participants=max(0, len(participant_sessions) - online),
        total_incidents=incident_count,
        unreviewed_incidents=unreviewed,
    )


@router.get("/exams/{exam_id}/monitor", response_model=list[ParticipantCard])
def monitor_participants(
    exam_id: str,
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[ParticipantCard]:
    require_exam_access(db, user, exam_id, "can_view_participants")
    exam = get_exam_or_404(db, exam_id)
    exam_session = get_active_exam_session(db, exam.id)
    if exam_session is None:
        return []
    return _cards_for_exam_session(db, exam, exam_session)


@router.get("/exams/{exam_id}/monitor/state", response_model=MonitoringStateOut)
def monitor_state(
    exam_id: str,
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
) -> MonitoringStateOut:
    """Everything the live dashboard needs in one round-trip."""
    require_exam_access(db, user, exam_id, "can_view_participants")
    exam = get_exam_or_404(db, exam_id)
    exam_session = get_active_exam_session(db, exam.id)
    if exam_session is None:
        return MonitoringStateOut(
            cards=[],
            incidents=[],
            timer=_timer_payload(exam, None),
            server_time=utcnow(),
        )
    return MonitoringStateOut(
        cards=_cards_for_exam_session(db, exam, exam_session),
        incidents=_incidents_for_exam_session(db, exam_session.id),
        timer=_timer_payload(exam, exam_session),
        server_time=utcnow(),
    )


@router.get("/exams/{exam_id}/timer", response_model=MonitoringTimerOut)
def exam_timer(
    exam_id: str,
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
) -> MonitoringTimerOut:
    require_exam_access(db, user, exam_id, "can_view_exam")
    exam = get_exam_or_404(db, exam_id)
    exam_session = get_active_exam_session(db, exam.id)
    return _timer_payload(exam, exam_session)


@router.get("/participant-sessions/{participant_session_id}", response_model=ParticipantDetail)
def participant_detail(
    participant_session_id: str,
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
) -> ParticipantDetail:
    ps = db.get(ParticipantSession, participant_session_id)
    if ps is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sesi peserta tidak ditemukan.")
    exam_session = db.get(ExamSession, ps.exam_session_id)
    require_exam_access(db, user, exam_session.exam_id, "can_view_participants")
    exam = get_exam_or_404(db, exam_session.exam_id)

    roster = _roster_map(db, exam.id)
    incidents_map = incident_counts_for_exam_session(db, exam_session.id)
    latest_events = latest_event_map(db, [ps.id])
    latest_incidents = latest_incident_map(db, exam_session.id)
    card = _build_card(
        db,
        ps,
        roster,
        incidents_map,
        latest_event=latest_events.get(ps.id, (None, None)),
        latest_incident=latest_incidents.get(ps.id),
        exam_session=exam_session,
    )

    events = list(
        db.scalars(
            select(MonitoringEvent)
            .where(MonitoringEvent.participant_session_id == ps.id)
            .order_by(MonitoringEvent.received_at.desc())
            .limit(200)
        ).all()
    )
    incidents = list(
        db.scalars(
            select(ViolationIncident)
            .where(ViolationIncident.participant_session_id == ps.id)
            .order_by(ViolationIncident.started_at.desc())
        ).all()
    )
    return ParticipantDetail(
        **card.model_dump(),
        commitment={
            "accepted": ps.commitment_accepted,
            "version": ps.commitment_version,
            "accepted_at": ensure_utc(ps.commitment_accepted_at),
            "npm_reported": ps.npm_reported,
        },
        events=[MonitoringEventOut.model_validate(event) for event in events],
        incidents=[IncidentOut.model_validate(incident) for incident in incidents],
    )


@router.get("/exams/{exam_id}/incidents", response_model=list[IncidentOut])
def list_incidents(
    exam_id: str,
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
    review_status: Optional[str] = Query(default=None),
) -> list[IncidentOut]:
    require_exam_access(db, user, exam_id, "can_review_incidents")
    exam = get_exam_or_404(db, exam_id)
    exam_session = get_active_exam_session(db, exam.id)
    if exam_session is None:
        return []
    query = (
        select(ViolationIncident)
        .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
        .where(ParticipantSession.exam_session_id == exam_session.id)
        .order_by(ViolationIncident.started_at.desc())
    )
    if review_status:
        query = query.where(ViolationIncident.review_status == review_status)
    incidents = db.scalars(query).all()
    context = incident_context_map(db, [incident.id for incident in incidents])
    enriched: list[IncidentOut] = []
    for incident in incidents:
        payload = IncidentOut.model_validate(incident)
        host, name = context.get(incident.id, (None, None))
        payload.page_host = host
        payload.participant_name = name
        enriched.append(payload)
    return enriched


@router.patch("/incidents/{incident_id}", response_model=IncidentOut)
async def review_incident(
    incident_id: str,
    payload: IncidentReviewRequest,
    user: DashboardUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> IncidentOut:
    incident = db.get(ViolationIncident, incident_id)
    if incident is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Insiden tidak ditemukan.")
    ps = db.get(ParticipantSession, incident.participant_session_id)
    exam_session = db.get(ExamSession, ps.exam_session_id)
    require_exam_access(db, user, exam_session.exam_id, "can_review_incidents")

    incident.review_status = payload.review_status
    incident.notes = payload.notes
    incident.reviewed_by = user.id
    incident.reviewed_at = utcnow()
    record_audit(
        db,
        action="incident.reviewed",
        actor=user,
        resource_type="incident",
        resource_id=incident.id,
        metadata={"review_status": payload.review_status},
        ip_address=client_ip(request),
    )
    db.commit()

    await manager.send_to_exam(
        exam_session.id,
        envelope(
            "incident_reviewed",
            {
                "incident_id": incident.id,
                "participant_session_id": ps.id,
                "review_status": incident.review_status,
            },
        ),
    )
    result = IncidentOut.model_validate(incident)
    host, name = incident_context_map(db, [incident.id]).get(incident.id, (None, None))
    result.page_host = host
    result.participant_name = name
    return result


@router.get("/audit-logs", response_model=list[AuditLogOut])
def list_audit_logs(
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, le=500),
    action: Optional[str] = Query(default=None),
) -> list[AuditLogOut]:
    if user.role != "ADMIN":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Akses hanya untuk administrator.")
    from ..models import AuditLog

    query = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    if action:
        query = query.where(AuditLog.action == action)
    entries = db.scalars(query).all()
    return [AuditLogOut.model_validate(entry) for entry in entries]
