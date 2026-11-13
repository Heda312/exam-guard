"""Exam CRUD, lifecycle control and roster management (spec §8, §9, §12)."""
from __future__ import annotations

from typing import Annotated, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import record_audit
from ..config import settings
from ..database import get_db
from ..deps import AdminUser, DashboardUser, client_ip, get_exam_or_404, require_exam_access
from ..models import Exam, ExamParticipant, ExamProctor, ExamSession, ParticipantSession, User, utcnow
from ..schemas import (
    ExamCreate,
    ExamOut,
    ExamStatusUpdate,
    ExamSummaryOut,
    ExamUpdate,
    MessageResponse,
    RosterEntryCreate,
    RosterEntryOut,
    RosterEntryUpdate,
    RosterImportCommitResult,
    RosterImportErrorReportRequest,
    RosterImportPreview,
    RosterImportRow,
)
from ..services import reports
from ..services.exams import (
    ExamValidationError,
    end_exam,
    generate_exam_code,
    get_active_exam_session,
    start_exam,
    validate_exam_code,
    validate_google_forms_url,
)
from ..services.roster import (
    RosterError,
    build_import_preview,
    commit_import,
    create_roster_entry,
    delete_roster_entry,
    error_report_csv,
    update_roster_entry,
)
from ..states import EXAM_TRANSITIONS, InvalidTransition, assert_exam_transition
from ..ws import envelope, manager

router = APIRouter(tags=["exams"])

MAX_CSV_BYTES = 2 * 1024 * 1024


def _exam_summary(db: Session, exam: Exam) -> ExamSummaryOut:
    participant_count = int(
        db.scalar(select(func.count(ExamParticipant.id)).where(ExamParticipant.exam_id == exam.id)) or 0
    )
    proctor_count = int(
        db.scalar(select(func.count(ExamProctor.id)).where(ExamProctor.exam_id == exam.id)) or 0
    )
    exam_session = get_active_exam_session(db, exam.id)
    incident_count = 0
    if exam_session is not None:
        from ..models import ViolationIncident

        incident_count = int(
            db.scalar(
                select(func.count(ViolationIncident.id))
                .join(ParticipantSession, ParticipantSession.id == ViolationIncident.participant_session_id)
                .where(ParticipantSession.exam_session_id == exam_session.id)
            )
            or 0
        )

    data = ExamOut.model_validate(exam).model_dump()
    return ExamSummaryOut(
        **data,
        participant_count=participant_count,
        proctor_count=proctor_count,
        incident_count=incident_count,
        exam_session_id=exam_session.id if exam_session else None,
        session_status=exam_session.status if exam_session else None,
        started_at=exam_session.started_at if exam_session else None,
        ends_at=exam_session.ends_at if exam_session else None,
        server_time=utcnow(),
    )


def _visible_exams(db: Session, user: User) -> list[Exam]:
    if user.role == "ADMIN":
        return list(db.scalars(select(Exam).order_by(Exam.created_at.desc())).all())
    exam_ids = db.scalars(
        select(ExamProctor.exam_id).where(
            ExamProctor.proctor_user_id == user.id, ExamProctor.can_view_exam.is_(True)
        )
    ).all()
    if not exam_ids:
        return []
    return list(
        db.scalars(select(Exam).where(Exam.id.in_(exam_ids)).order_by(Exam.created_at.desc())).all()
    )


@router.get("/exams", response_model=list[ExamSummaryOut])
def list_exams(user: DashboardUser, db: Annotated[Session, Depends(get_db)]) -> list[ExamSummaryOut]:
    return [_exam_summary(db, exam) for exam in _visible_exams(db, user)]


@router.post("/exams", response_model=ExamSummaryOut, status_code=status.HTTP_201_CREATED)
def create_exam(
    payload: ExamCreate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamSummaryOut:
    try:
        exam_code = validate_exam_code(payload.exam_code) if payload.exam_code else generate_exam_code(db)
        forms_url = validate_google_forms_url(payload.google_forms_url)
    except ExamValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": exc.field, "message": exc.message},
        ) from exc

    if db.scalar(select(Exam).where(Exam.exam_code == exam_code)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Exam ID sudah digunakan.")

    if payload.status not in {"DRAFT", "SCHEDULED", "REGISTRATION_OPEN"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Ujian baru hanya dapat dibuat sebagai DRAFT, SCHEDULED, atau REGISTRATION_OPEN.",
        )

    exam = Exam(
        exam_code=exam_code,
        name=payload.name.strip(),
        description=payload.description,
        google_forms_url=forms_url,
        scheduled_at=payload.scheduled_at,
        duration_minutes=payload.duration_minutes,
        registration_opens_at=payload.registration_opens_at,
        registration_closes_at=payload.registration_closes_at,
        status=payload.status,
        created_by=admin.id,
    )
    db.add(exam)
    db.flush()
    record_audit(
        db,
        action="exam.created",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"exam_code": exam_code, "name": exam.name, "status": exam.status},
        ip_address=client_ip(request),
    )
    db.commit()
    return _exam_summary(db, exam)


@router.get("/exams/{exam_id}", response_model=ExamSummaryOut)
def get_exam(exam_id: str, user: DashboardUser, db: Annotated[Session, Depends(get_db)]) -> ExamSummaryOut:
    require_exam_access(db, user, exam_id, "can_view_exam")
    exam = get_exam_or_404(db, exam_id)
    return _exam_summary(db, exam)


@router.patch("/exams/{exam_id}", response_model=ExamSummaryOut)
def update_exam(
    exam_id: str,
    payload: ExamUpdate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamSummaryOut:
    exam = get_exam_or_404(db, exam_id)
    if exam.status in {"LIVE", "COMPLETED", "CANCELLED"}:
        immutable = {"duration_minutes", "google_forms_url"}
        if any(getattr(payload, field) is not None for field in immutable):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Durasi dan URL formulir tidak dapat diubah setelah ujian dimulai.",
            )

    try:
        if payload.google_forms_url is not None:
            exam.google_forms_url = validate_google_forms_url(payload.google_forms_url)
    except ExamValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": exc.field, "message": exc.message},
        ) from exc

    changes: dict[str, object] = {}
    for field in ("name", "description", "scheduled_at", "duration_minutes",
                  "registration_opens_at", "registration_closes_at"):
        value = getattr(payload, field)
        if value is not None:
            setattr(exam, field, value.strip() if isinstance(value, str) and field == "name" else value)
            changes[field] = str(value)

    record_audit(
        db,
        action="exam.updated",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata=changes,
        ip_address=client_ip(request),
    )
    db.commit()
    return _exam_summary(db, exam)


@router.post("/exams/{exam_id}/status", response_model=ExamSummaryOut)
def change_exam_status(
    exam_id: str,
    payload: ExamStatusUpdate,
    user: DashboardUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamSummaryOut:
    exam = get_exam_or_404(db, exam_id)
    if payload.status in {"STARTING", "LIVE"}:
        require_exam_access(db, user, exam_id, "can_start_exam")
    elif payload.status == "COMPLETED":
        require_exam_access(db, user, exam_id, "can_end_exam")
    elif user.role != "ADMIN":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Hanya administrator yang dapat mengubah status ini.")

    try:
        assert_exam_transition(exam.status, payload.status)
    except InvalidTransition as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    previous_status = exam.status
    exam.status = payload.status
    record_audit(
        db,
        action="exam.status_changed",
        actor=user,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"from": previous_status, "to": payload.status, "exam_code": exam.exam_code, "exam_name": exam.name},
        ip_address=client_ip(request),
    )
    db.commit()
    return _exam_summary(db, exam)


@router.post("/exams/{exam_id}/start", response_model=ExamSummaryOut)
async def start_exam_endpoint(
    exam_id: str,
    user: DashboardUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamSummaryOut:
    require_exam_access(db, user, exam_id, "can_start_exam")
    exam = get_exam_or_404(db, exam_id)
    try:
        session, participants = start_exam(db, exam, user.id)
    except ExamValidationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    record_audit(
        db,
        action="exam.started",
        actor=user,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"exam_session_id": session.id, "exam_code": exam.exam_code, "exam_name": exam.name, "duration_minutes": exam.duration_minutes},
        ip_address=client_ip(request),
    )
    db.commit()

    await manager.send_to_exam(
        session.id,
        envelope(
            "exam_started",
            {
                "exam_session_id": session.id,
                "started_at": session.started_at,
                "ends_at": session.ends_at,
                "google_forms_url": exam.google_forms_url,
                "participant_session_ids": [ps.id for ps in participants],
            },
        ),
    )
    for ps in participants:
        await manager.send_to_participant(
            ps.id,
            envelope(
                "exam_started",
                {"participant_session_id": ps.id, "ends_at": session.ends_at, "status": ps.status},
            ),
        )
    return _exam_summary(db, exam)


@router.post("/exams/{exam_id}/end", response_model=ExamSummaryOut)
async def end_exam_endpoint(
    exam_id: str,
    user: DashboardUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamSummaryOut:
    require_exam_access(db, user, exam_id, "can_end_exam")
    exam = get_exam_or_404(db, exam_id)
    try:
        session, participants = end_exam(db, exam, user.id)
    except ExamValidationError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    record_audit(
        db,
        action="exam.ended",
        actor=user,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"exam_session_id": session.id, "exam_code": exam.exam_code, "exam_name": exam.name},
        ip_address=client_ip(request),
    )
    db.commit()

    for ps in participants:
        await manager.send_to_participant(
            ps.id,
            envelope("exam_ended", {"participant_session_id": ps.id, "status": ps.status}),
        )
    await manager.send_to_exam(
        session.id, envelope("exam_ended", {"exam_session_id": session.id, "status": "COMPLETED"})
    )
    return _exam_summary(db, exam)


@router.post("/exams/{exam_id}/validate-form-url")
def validate_form_url(
    exam_id: str,
    payload: dict,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Validate a Google Forms URL before publishing (spec §8.3)."""
    get_exam_or_404(db, exam_id)
    candidate = payload.get("url")
    try:
        normalized = validate_google_forms_url(candidate)
    except ExamValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": exc.field, "message": exc.message},
        ) from exc
    if normalized is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "google_forms_url", "message": "URL formulir wajib diisi."},
        )
    return {"valid": True, "url": normalized, "host": urlparse(normalized).hostname}


# --- Roster ---------------------------------------------------------------
@router.get("/exams/{exam_id}/roster", response_model=list[RosterEntryOut])
def list_roster(
    exam_id: str,
    user: DashboardUser,
    db: Annotated[Session, Depends(get_db)],
    search: Optional[str] = Query(default=None, max_length=120),
) -> list[RosterEntryOut]:
    require_exam_access(db, user, exam_id, "can_view_participants")
    exam = get_exam_or_404(db, exam_id)
    exam_session = get_active_exam_session(db, exam.id)

    status_by_participant: dict[str, str] = {}
    if exam_session is not None:
        for ps in db.scalars(
            select(ParticipantSession).where(ParticipantSession.exam_session_id == exam_session.id)
        ).all():
            status_by_participant[ps.participant_id] = ps.status

    links = list(
        db.scalars(
            select(ExamParticipant)
            .where(ExamParticipant.exam_id == exam.id)
            .order_by(ExamParticipant.normalized_name)
        ).all()
    )
    result: list[RosterEntryOut] = []
    needle = (search or "").strip().lower()
    for link in links:
        participant = link.participant
        if needle and needle not in participant.full_name.lower() and needle not in (participant.npm or "").lower():
            continue
        result.append(
            RosterEntryOut(
                id=link.id,
                participant_id=participant.id,
                exam_id=link.exam_id,
                full_name=participant.full_name,
                normalized_name=link.normalized_name,
                npm=participant.npm,
                email=participant.email,
                group_name=link.group_name,
                notes=participant.notes,
                created_at=link.created_at,
                participant_session_status=status_by_participant.get(participant.id),
            )
        )
    return result


@router.post("/exams/{exam_id}/roster", response_model=RosterEntryOut, status_code=status.HTTP_201_CREATED)
def add_roster_entry(
    exam_id: str,
    payload: RosterEntryCreate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> RosterEntryOut:
    exam = get_exam_or_404(db, exam_id)
    if exam.status in {"LIVE", "COMPLETED", "CANCELLED"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Roster tidak dapat diubah setelah ujian dimulai.",
        )
    try:
        link = create_roster_entry(
            db,
            exam,
            full_name=payload.full_name,
            npm=payload.npm,
            email=payload.email,
            group_name=payload.group_name,
            notes=payload.notes,
        )
    except RosterError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    record_audit(
        db,
        action="roster.participant_added",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"name": link.participant.full_name},
        ip_address=client_ip(request),
    )
    db.commit()
    participant = link.participant
    return RosterEntryOut(
        id=link.id,
        participant_id=participant.id,
        exam_id=link.exam_id,
        full_name=participant.full_name,
        normalized_name=link.normalized_name,
        npm=participant.npm,
        email=participant.email,
        group_name=link.group_name,
        notes=participant.notes,
        created_at=link.created_at,
    )


@router.patch("/exams/{exam_id}/roster/{entry_id}", response_model=RosterEntryOut)
def edit_roster_entry(
    exam_id: str,
    entry_id: str,
    payload: RosterEntryUpdate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> RosterEntryOut:
    exam = get_exam_or_404(db, exam_id)
    link = db.get(ExamParticipant, entry_id)
    if link is None or link.exam_id != exam.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Peserta tidak ditemukan pada roster.")
    try:
        update_roster_entry(db, link, **payload.model_dump(exclude_unset=True))
    except RosterError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    record_audit(
        db,
        action="roster.participant_updated",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"name": link.participant.full_name, "changes": payload.model_dump(exclude_unset=True)},
        ip_address=client_ip(request),
    )
    db.commit()
    participant = link.participant
    return RosterEntryOut(
        id=link.id,
        participant_id=participant.id,
        exam_id=link.exam_id,
        full_name=participant.full_name,
        normalized_name=link.normalized_name,
        npm=participant.npm,
        email=participant.email,
        group_name=link.group_name,
        notes=participant.notes,
        created_at=link.created_at,
    )


@router.delete("/exams/{exam_id}/roster/{entry_id}", response_model=MessageResponse)
def remove_roster_entry(
    exam_id: str,
    entry_id: str,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    exam = get_exam_or_404(db, exam_id)
    link = db.get(ExamParticipant, entry_id)
    if link is None or link.exam_id != exam.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Peserta tidak ditemukan pada roster.")
    record_audit(
        db,
        action="roster.participant_removed",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"name": link.participant.full_name},
        ip_address=client_ip(request),
    )
    delete_roster_entry(db, link)
    db.commit()
    return MessageResponse(message="Peserta dihapus dari roster.")


async def _read_csv(file: UploadFile) -> bytes:
    content = await file.read()
    if len(content) > MAX_CSV_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Berkas CSV maksimal 2 MB.")
    if not content.strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Berkas CSV kosong.")
    return content


@router.post("/exams/{exam_id}/roster/import/preview", response_model=RosterImportPreview)
async def preview_roster_import(
    exam_id: str,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    file: UploadFile = File(...),
) -> RosterImportPreview:
    exam = get_exam_or_404(db, exam_id)
    content = await _read_csv(file)
    try:
        rows = build_import_preview(db, exam, content)
    except RosterError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return RosterImportPreview(
        rows=rows,
        total_rows=len(rows),
        valid_rows=sum(1 for row in rows if row.status == "ok"),
        warning_rows=sum(1 for row in rows if row.status == "duplicate_in_file"),
        error_rows=sum(1 for row in rows if row.status in {"invalid", "duplicate_in_roster"}),
    )


@router.post("/exams/{exam_id}/roster/import", response_model=RosterImportCommitResult)
async def commit_roster_import(
    exam_id: str,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    file: UploadFile = File(...),
) -> RosterImportCommitResult:
    exam = get_exam_or_404(db, exam_id)
    if exam.status in {"LIVE", "COMPLETED", "CANCELLED"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Roster tidak dapat diimpor setelah ujian dimulai.",
        )
    content = await _read_csv(file)
    try:
        imported, skipped, errors = commit_import(db, exam, content)
    except RosterError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    record_audit(
        db,
        action="roster.imported",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"imported": imported, "skipped": skipped},
        ip_address=client_ip(request),
    )
    db.commit()
    return RosterImportCommitResult(imported=imported, skipped=skipped, errors=errors)


@router.post("/exams/{exam_id}/roster/import/error-report")
def download_import_error_report(
    exam_id: str,
    payload: RosterImportErrorReportRequest,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """CSV error report for a previewed/committed import (spec §9.2)."""
    exam = get_exam_or_404(db, exam_id)
    return Response(
        content=error_report_csv(payload.rows),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="roster-import-errors-{exam.exam_code}.csv"'
        },
    )


@router.get("/exams/{exam_id}/roster/import/template")
def download_import_template(
    exam_id: str,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Downloadable CSV template for roster imports (spec §9.2)."""
    exam = get_exam_or_404(db, exam_id)
    sample = (
        "full_name,npm,email,group_name\n"
        "Alek Nurhabib,2021001,alek@example.com,Kelas A\n"
        "Siti Aminah,2021002,,Kelas B\n"
    )
    return Response(
        content=sample,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="roster-template.csv"'},
    )


# --- Reports --------------------------------------------------------------
@router.get("/exams/{exam_id}/report.csv")
def export_report_csv(
    exam_id: str,
    user: DashboardUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    require_exam_access(db, user, exam_id, "can_export_report")
    exam = get_exam_or_404(db, exam_id)
    rows = reports.collect_rows(db, exam)
    record_audit(
        db,
        action="report.exported",
        actor=user,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"format": "csv", "rows": len(rows)},
        ip_address=client_ip(request),
    )
    db.commit()
    return Response(
        content=reports.csv_timezone_note() + reports.to_csv(rows),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="examguard-{exam.exam_code}.csv"'
        },
    )


@router.get("/exams/{exam_id}/report.xlsx")
def export_report_xlsx(
    exam_id: str,
    user: DashboardUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    require_exam_access(db, user, exam_id, "can_export_report")
    exam = get_exam_or_404(db, exam_id)
    rows = reports.collect_rows(db, exam)
    incidents = reports.incident_rows(db, exam)
    payload = reports.to_xlsx(rows, incidents)
    record_audit(
        db,
        action="report.exported",
        actor=user,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"format": "xlsx", "rows": len(rows)},
        ip_address=client_ip(request),
    )
    db.commit()
    return Response(
        content=payload,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="examguard-{exam.exam_code}.xlsx"'
        },
    )


@router.delete("/exams/{exam_id}", response_model=MessageResponse)
def delete_exam(
    exam_id: str,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    """Delete an exam and everything attached to it (admin only)."""
    exam = get_exam_or_404(db, exam_id)
    if exam.status not in {"DRAFT", "SCHEDULED", "REGISTRATION_OPEN", "WAITING", "COMPLETED", "CANCELLED"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ujian yang sedang LIVE tidak dapat dihapus. Akhiri ujian terlebih dahulu.",
        )
    record_audit(
        db,
        action="exam.deleted",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"exam_code": exam.exam_code, "name": exam.name, "status": exam.status},
        ip_address=client_ip(request),
    )
    db.delete(exam)
    db.commit()
    return MessageResponse(message="Ujian dihapus.")


__all__ = ["router", "EXAM_TRANSITIONS"]
