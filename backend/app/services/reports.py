"""Report generation (CSV / XLSX) — spec §20."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Exam, ExamParticipant, ExamSession, MonitoringEvent, ParticipantSession, ViolationIncident
from ..services.exams import ensure_utc
from ..services.monitoring import EVENT_SUMMARIES, incident_counts_for_exam_session

REPORT_COLUMNS = [
    "exam_code",
    "exam_name",
    "participant_name",
    "npm",
    "group_name",
    "session_status",
    "connection_state",
    "commitment_accepted",
    "commitment_version",
    "commitment_accepted_at",
    "incident_count",
    "unreviewed_incident_count",
    "connection_lost_seconds",
    "first_connected_at",
    "last_heartbeat_at",
    "completed_at",
    "started_at",
    "ends_at",
]


def _iso(value: Optional[datetime]) -> str:
    if value is None:
        return ""
    value = ensure_utc(value)
    return value.isoformat() if value else ""


def collect_rows(db: Session, exam: Exam) -> list[dict[str, str]]:
    exam_session: Optional[ExamSession] = db.scalar(
        select(ExamSession).where(ExamSession.exam_id == exam.id).order_by(ExamSession.created_at.desc())
    )
    rows: list[dict[str, str]] = []
    if exam_session is None:
        return rows

    incidents = list(
        db.scalars(
            select(ViolationIncident)
            .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
            .where(ParticipantSession.exam_session_id == exam_session.id)
        ).all()
    )
    incident_totals: dict[str, int] = {}
    unreviewed: dict[str, int] = {}
    for incident in incidents:
        incident_totals[incident.participant_session_id] = incident_totals.get(incident.participant_session_id, 0) + 1
        if incident.review_status == "UNREVIEWED":
            unreviewed[incident.participant_session_id] = unreviewed.get(incident.participant_session_id, 0) + 1

    sessions = list(
        db.scalars(
            select(ParticipantSession).where(ParticipantSession.exam_session_id == exam_session.id)
        ).all()
    )
    for ps in sessions:
        roster = db.scalar(
            select(ExamParticipant).where(
                ExamParticipant.exam_id == exam.id,
                ExamParticipant.participant_id == ps.participant_id,
            )
        )
        participant = ps.participant
        rows.append(
            {
                "exam_code": exam.exam_code,
                "exam_name": exam.name,
                "participant_name": participant.full_name,
                "npm": participant.npm or "",
                "group_name": (roster.group_name if roster else "") or "",
                "session_status": ps.status,
                "connection_state": "ONLINE" if ps.status in {"READY", "MONITORING"} else "OFFLINE",
                "commitment_accepted": "yes" if ps.commitment_accepted else "no",
                "commitment_version": ps.commitment_version or "",
                "commitment_accepted_at": _iso(ps.commitment_accepted_at),
                "incident_count": str(incident_totals.get(ps.id, 0)),
                "unreviewed_incident_count": str(unreviewed.get(ps.id, 0)),
                "connection_lost_seconds": str(ps.connection_lost_seconds),
                "first_connected_at": _iso(ps.connected_at),
                "last_heartbeat_at": _iso(ps.last_heartbeat_at),
                "completed_at": _iso(ps.completed_at),
                "started_at": _iso(exam_session.started_at),
                "ends_at": _iso(exam_session.ends_at),
            }
        )
    rows.sort(key=lambda item: item["participant_name"].lower())
    return rows


def to_csv(rows: Iterable[dict[str, str]]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=REPORT_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buffer.getvalue()


def incident_rows(db: Session, exam: Exam) -> list[dict[str, str]]:
    exam_session = db.scalar(
        select(ExamSession).where(ExamSession.exam_id == exam.id).order_by(ExamSession.created_at.desc())
    )
    if exam_session is None:
        return []
    incidents = list(
        db.scalars(
            select(ViolationIncident)
            .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
            .where(ParticipantSession.exam_session_id == exam_session.id)
            .order_by(ViolationIncident.started_at)
        ).all()
    )
    rows = []
    for incident in incidents:
        ps = incident.participant_session
        rows.append(
            {
                "exam_code": exam.exam_code,
                "participant_name": ps.participant.full_name,
                "incident_type": incident.incident_type,
                "started_at": _iso(incident.started_at),
                "ended_at": _iso(incident.ended_at),
                "event_count": str(incident.event_count),
                "review_status": incident.review_status,
                "notes": incident.notes or "",
            }
        )
    return rows


def to_xlsx(rows: list[dict[str, str]], incident_rows_: list[dict[str, str]]) -> bytes:
    """Build a two-sheet workbook: participant summary + incidents."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    workbook = Workbook()
    header_fill = PatternFill("solid", fgColor="18392C")
    header_font = Font(color="FFFCF6", bold=True)

    def write_sheet(sheet, columns: list[str], data: list[dict[str, str]]) -> None:
        sheet.append(columns)
        for cell in sheet[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(vertical="center")
        for row in data:
            sheet.append([row.get(col, "") for col in columns])
        for index, column in enumerate(columns, start=1):
            longest = max([len(column)] + [len(str(row.get(column, ""))) for row in data] or [0])
            sheet.column_dimensions[get_column_letter(index)].width = min(max(12, longest + 2), 48)
        sheet.freeze_panes = "A2"

    summary = workbook.active
    summary.title = "Participants"
    write_sheet(summary, REPORT_COLUMNS, rows)

    incidents_sheet = workbook.create_sheet("Incidents")
    incident_columns = [
        "exam_code",
        "participant_name",
        "incident_type",
        "started_at",
        "ended_at",
        "event_count",
        "review_status",
        "notes",
    ]
    write_sheet(incidents_sheet, incident_columns, incident_rows_)

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
