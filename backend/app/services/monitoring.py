"""Monitoring event ingestion and incident correlation (spec §15)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import MonitoringEvent, Participant, ParticipantSession, ViolationIncident, utcnow
from ..schemas import MonitoringEventIn

# Which raw event types can open a behavioural incident.
INCIDENT_TYPES = {
    "TAB_SWITCH",
    "NEW_TAB",
    "FOCUS_LOST",
    "WINDOW_MINIMIZED",
    "NAVIGATION",
    "TAB_CLOSED",
    "COPY_ATTEMPT",
    "CUT_ATTEMPT",
    "PASTE_ATTEMPT",
    "GUARD_TAMPERED",
}

# Events that close an open episode instead of opening a new one.
EPISODE_CLOSING_EVENTS = {"FOCUS_RESTORED"}

CONNECTION_EVENTS = {"CONNECTION_LOST"}

EVENT_SUMMARIES = {
    "TAB_SWITCH": "Berpindah tab",
    "NEW_TAB": "Membuka tab baru",
    "TAB_CLOSED": "Menutup tab",
    "FOCUS_LOST": "Fokus jendela ujian hilang",
    "WINDOW_MINIMIZED": "Jendela diminimalkan",
    "NAVIGATION": "Navigasi halaman",
    "CONNECTION_LOST": "Koneksi terputus",
    "FOCUS_RESTORED": "Fokus kembali",
    "COPY_ATTEMPT": "Percobaan menyalin teks",
    "CUT_ATTEMPT": "Percobaan memotong teks",
    "PASTE_ATTEMPT": "Percobaan menempel teks",
    "GUARD_TAMPERED": "Pemantauan diganggu extension lain",
}


def sanitize_host(url: Optional[str]) -> Optional[str]:
    """Store only the host; never persist full URLs with query strings (spec §21)."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    return host[:255] or None


def _ensure_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def find_open_incident(db: Session, participant_session_id: str) -> Optional[ViolationIncident]:
    return db.scalar(
        select(ViolationIncident)
        .where(
            ViolationIncident.participant_session_id == participant_session_id,
            ViolationIncident.ended_at.is_(None),
        )
        .order_by(ViolationIncident.started_at.desc())
    )


def record_event(
    db: Session,
    participant_session: ParticipantSession,
    payload: MonitoringEventIn,
) -> tuple[MonitoringEvent, Optional[ViolationIncident]]:
    """Persist a raw event, correlate it into an incident, and return both.

    Idempotency: a repeated ``client_event_id`` for the same participant session
    returns the stored row instead of creating a duplicate (spec §14.4, §19).
    """
    if payload.client_event_id:
        existing = db.scalar(
            select(MonitoringEvent).where(
                MonitoringEvent.participant_session_id == participant_session.id,
                MonitoringEvent.client_event_id == payload.client_event_id,
            )
        )
        if existing is not None:
            incident = (
                db.get(ViolationIncident, existing.incident_id) if existing.incident_id else None
            )
            return existing, incident

    event = MonitoringEvent(
        participant_session_id=participant_session.id,
        client_event_id=payload.client_event_id,
        event_type=payload.event_type,
        client_timestamp=_ensure_utc(payload.client_timestamp),
        received_at=utcnow(),
        tab_id=payload.tab_id,
        window_id=payload.window_id,
        page_host=sanitize_host(payload.page_url),
        page_url=None,  # data minimisation: host only
        metadata_json=payload.metadata or {},
        extension_version=payload.extension_version,
    )
    db.add(event)
    db.flush()

    incident = _correlate(db, participant_session, event)
    if incident is not None:
        event.incident_id = incident.id
    db.flush()
    return event, incident


def _correlate(
    db: Session, participant_session: ParticipantSession, event: MonitoringEvent
) -> Optional[ViolationIncident]:
    """Correlate raw events into behavioural episodes (spec §15.2)."""
    if event.event_type in CONNECTION_EVENTS:
        return None

    open_incident = find_open_incident(db, participant_session.id)
    window = timedelta(milliseconds=settings.incident_correlation_ms)
    received = _ensure_utc(event.received_at) or utcnow()

    if event.event_type in EPISODE_CLOSING_EVENTS:
        if open_incident is not None:
            open_incident.ended_at = received
        return None

    if event.event_type not in INCIDENT_TYPES:
        return None

    if open_incident is not None:
        last_activity = _ensure_utc(open_incident.started_at) or received
        if received - last_activity <= window or open_incident.incident_type in {
            "FOCUS_LOST",
            "WINDOW_MINIMIZED",
        }:
            open_incident.event_count += 1
            return open_incident
        # A clearly separate episode.
        open_incident.ended_at = received

    incident = ViolationIncident(
        participant_session_id=participant_session.id,
        incident_type=event.event_type,
        started_at=received,
        event_count=1,
        review_status="UNREVIEWED",
    )
    db.add(incident)
    db.flush()
    return incident


def incident_count(db: Session, participant_session_id: str) -> int:
    return int(
        db.scalar(
            select(func.count(ViolationIncident.id)).where(
                ViolationIncident.participant_session_id == participant_session_id
            )
        )
        or 0
    )


def incident_counts_for_exam_session(db: Session, exam_session_id: str) -> dict[str, int]:
    rows = db.execute(
        select(ViolationIncident.participant_session_id, func.count(ViolationIncident.id))
        .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
        .where(ParticipantSession.exam_session_id == exam_session_id)
        .group_by(ViolationIncident.participant_session_id)
    ).all()
    return {row[0]: int(row[1]) for row in rows}


def _summarize_event(event_type: str, page_host: Optional[str]) -> str:
    summary = EVENT_SUMMARIES.get(event_type, event_type)
    if page_host:
        summary = f"{summary} · {page_host}"
    return summary


def latest_event_summary(db: Session, participant_session_id: str) -> tuple[Optional[str], Optional[datetime]]:
    event = db.scalar(
        select(MonitoringEvent)
        .where(MonitoringEvent.participant_session_id == participant_session_id)
        .order_by(MonitoringEvent.received_at.desc())
        .limit(1)
    )
    if event is None:
        return None, None
    return _summarize_event(event.event_type, event.page_host), _ensure_utc(event.received_at)


def latest_event_map(
    db: Session, participant_session_ids: list[str]
) -> dict[str, tuple[Optional[str], Optional[datetime]]]:
    """Latest event summary per participant session, in one query.

    Building a monitoring card used to run one (or two) queries per participant;
    with a full classroom that made every dashboard refresh an N+1 problem.
    """
    if not participant_session_ids:
        return {}

    ranked = (
        select(
            MonitoringEvent.participant_session_id.label("participant_session_id"),
            MonitoringEvent.event_type.label("event_type"),
            MonitoringEvent.page_host.label("page_host"),
            MonitoringEvent.received_at.label("received_at"),
            func.row_number()
            .over(
                partition_by=MonitoringEvent.participant_session_id,
                order_by=MonitoringEvent.received_at.desc(),
            )
            .label("row_number"),
        )
        .where(MonitoringEvent.participant_session_id.in_(participant_session_ids))
        .subquery()
    )
    rows = db.execute(select(ranked).where(ranked.c.row_number == 1)).all()

    result: dict[str, tuple[Optional[str], Optional[datetime]]] = {}
    for row in rows:
        result[row.participant_session_id] = (
            _summarize_event(row.event_type, row.page_host),
            _ensure_utc(row.received_at),
        )
    return result


def latest_incident_map(
    db: Session, exam_session_id: str
) -> dict[str, ViolationIncident]:
    """Most recent incident per participant session, in one query."""
    incidents = db.scalars(
        select(ViolationIncident)
        .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
        .where(ParticipantSession.exam_session_id == exam_session_id)
        .order_by(
            ViolationIncident.participant_session_id,
            ViolationIncident.started_at.desc(),
        )
    ).all()
    result: dict[str, ViolationIncident] = {}
    for incident in incidents:
        result.setdefault(incident.participant_session_id, incident)
    return result


def incident_context_map(
    db: Session, incident_ids: list[str]
) -> dict[str, tuple[Optional[str], Optional[str]]]:
    """Map incident -> (page host, participant full name) in two queries.

    The incident table needs the domain the participant had open, but that lives
    on ``monitoring_events``, not on the incident row. Doing it per incident
    would reintroduce the N+1 pattern the dashboard just got rid of, so this
    fetches the newest event host per incident in one grouped query and the
    participant names in another.
    """
    if not incident_ids:
        return {}

    ranked = (
        select(
            MonitoringEvent.incident_id.label("incident_id"),
            MonitoringEvent.page_host.label("page_host"),
            func.row_number()
            .over(
                partition_by=MonitoringEvent.incident_id,
                order_by=MonitoringEvent.received_at.desc(),
            )
            .label("row_number"),
        )
        .where(MonitoringEvent.incident_id.in_(incident_ids))
        .subquery()
    )
    host_rows = db.execute(select(ranked).where(ranked.c.row_number == 1)).all()
    hosts: dict[str, Optional[str]] = {
        row.incident_id: row.page_host for row in host_rows
    }

    # Participant name per incident, joined through the participant session.
    name_rows = db.execute(
        select(
            ViolationIncident.id.label("incident_id"),
            Participant.full_name.label("full_name"),
        )
        .join(
            ParticipantSession,
            ParticipantSession.id == ViolationIncident.participant_session_id,
        )
        .join(Participant, Participant.id == ParticipantSession.participant_id)
        .where(ViolationIncident.id.in_(incident_ids))
    ).all()
    names: dict[str, Optional[str]] = {
        row.incident_id: row.full_name for row in name_rows
    }

    return {
        incident_id: (hosts.get(incident_id), names.get(incident_id))
        for incident_id in incident_ids
    }
