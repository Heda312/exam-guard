"""Admin: proctor account management and exam assignments (spec §3.2, §3.3)."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import record_audit
from ..database import get_db
from ..deps import AdminUser, client_ip, get_exam_or_404
from ..models import ExamProctor, User
from ..schemas import (
    ExamProctorOut,
    MessageResponse,
    ProctorAssignment,
    ProctorAssignmentUpdate,
    ProctorCreate,
    ProctorOut,
    ProctorPermissions,
    ProctorUpdate,
    UserOut,
)
from ..security import hash_password, validate_password_strength

router = APIRouter(prefix="/admin", tags=["admin:users"])


def _proctor_out(db: Session, user: User) -> ProctorOut:
    count = db.scalar(
        select(func.count(ExamProctor.id)).where(ExamProctor.proctor_user_id == user.id)
    )
    data = UserOut.model_validate(user).model_dump()
    return ProctorOut(**data, assigned_exam_count=int(count or 0))


@router.get("/proctors", response_model=list[ProctorOut])
def list_proctors(admin: AdminUser, db: Annotated[Session, Depends(get_db)]) -> list[ProctorOut]:
    users = db.scalars(select(User).where(User.role == "PROCTOR").order_by(User.created_at.desc())).all()
    return [_proctor_out(db, user) for user in users]


@router.post("/proctors", response_model=ProctorOut, status_code=status.HTTP_201_CREATED)
def create_proctor(
    payload: ProctorCreate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ProctorOut:
    username = payload.username.strip().lower()
    if db.scalar(select(User).where(User.username == username)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username sudah digunakan.")
    try:
        validate_password_strength(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    proctor = User(
        username=username,
        full_name=payload.full_name.strip(),
        password_hash=hash_password(payload.password),
        role="PROCTOR",
        is_active=True,
        must_change_password=False,
    )
    db.add(proctor)
    db.flush()
    record_audit(
        db,
        action="proctor.created",
        actor=admin,
        resource_type="user",
        resource_id=proctor.id,
        metadata={"username": username, "permissions": payload.permissions.model_dump()},
        ip_address=client_ip(request),
    )
    db.commit()
    return _proctor_out(db, proctor)


@router.patch("/proctors/{proctor_id}", response_model=ProctorOut)
def update_proctor(
    proctor_id: str,
    payload: ProctorUpdate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ProctorOut:
    proctor = db.get(User, proctor_id)
    if proctor is None or proctor.role != "PROCTOR":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proktor tidak ditemukan.")

    changes: dict[str, object] = {}
    if payload.full_name is not None:
        proctor.full_name = payload.full_name.strip()
        changes["full_name"] = proctor.full_name
    if payload.username is not None:
        username = payload.username.strip().lower()
        existing = db.scalar(select(User).where(User.username == username, User.id != proctor.id))
        if existing is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username sudah digunakan.")
        proctor.username = username
        changes["username"] = username
    if payload.is_active is not None:
        proctor.is_active = payload.is_active
        changes["is_active"] = payload.is_active
    if payload.password:
        try:
            validate_password_strength(payload.password)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
        proctor.password_hash = hash_password(payload.password)
        proctor.must_change_password = False
        changes["password_reset"] = True

    record_audit(
        db,
        action="proctor.updated",
        actor=admin,
        resource_type="user",
        resource_id=proctor.id,
        metadata=changes,
        ip_address=client_ip(request),
    )
    db.commit()
    return _proctor_out(db, proctor)


@router.delete("/proctors/{proctor_id}", response_model=MessageResponse)
def delete_proctor(
    proctor_id: str,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    """Delete a proctor account and all of its exam assignments."""
    proctor = db.get(User, proctor_id)
    if proctor is None or proctor.role != "PROCTOR":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proktor tidak ditemukan.")
    record_audit(
        db,
        action="proctor.deleted",
        actor=admin,
        resource_type="user",
        resource_id=proctor.id,
        metadata={"username": proctor.username},
        ip_address=client_ip(request),
    )
    db.delete(proctor)
    db.commit()
    return MessageResponse(message="Akun proktor dihapus.")


@router.get("/exams/{exam_id}/proctors", response_model=list[ExamProctorOut])
def list_exam_proctors(
    exam_id: str,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[ExamProctorOut]:
    exam = get_exam_or_404(db, exam_id)
    rows = db.scalars(select(ExamProctor).where(ExamProctor.exam_id == exam.id)).all()
    result = []
    for row in rows:
        proctor = db.get(User, row.proctor_user_id)
        result.append(
            ExamProctorOut(
                id=row.id,
                exam_id=row.exam_id,
                proctor_user_id=row.proctor_user_id,
                proctor_email=proctor.email if proctor and proctor.email else (proctor.username if proctor else ""),
                proctor_full_name=proctor.full_name if proctor else "",
                permissions=ProctorPermissions(
                    can_view_exam=row.can_view_exam,
                    can_view_participants=row.can_view_participants,
                    can_start_exam=row.can_start_exam,
                    can_end_exam=row.can_end_exam,
                    can_review_incidents=row.can_review_incidents,
                    can_export_report=row.can_export_report,
                ),
                created_at=row.created_at,
            )
        )
    return result


@router.post(
    "/exams/{exam_id}/proctors",
    response_model=ExamProctorOut,
    status_code=status.HTTP_201_CREATED,
)
def assign_proctor(
    exam_id: str,
    payload: ProctorAssignment,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamProctorOut:
    exam = get_exam_or_404(db, exam_id)
    proctor = db.get(User, payload.proctor_user_id)
    if proctor is None or proctor.role != "PROCTOR":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proktor tidak ditemukan.")
    if not proctor.is_active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Proktor tidak aktif.")

    existing = db.scalar(
        select(ExamProctor).where(
            ExamProctor.exam_id == exam.id, ExamProctor.proctor_user_id == proctor.id
        )
    )
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Proktor sudah ditugaskan pada ujian ini.")

    assignment = ExamProctor(
        exam_id=exam.id,
        proctor_user_id=proctor.id,
        can_view_exam=payload.permissions.can_view_exam,
        can_view_participants=payload.permissions.can_view_participants,
        can_start_exam=payload.permissions.can_start_exam,
        can_end_exam=payload.permissions.can_end_exam,
        can_review_incidents=payload.permissions.can_review_incidents,
        can_export_report=payload.permissions.can_export_report,
    )
    db.add(assignment)
    record_audit(
        db,
        action="exam.proctor_assigned",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"proctor_user_id": proctor.id, "permissions": payload.permissions.model_dump()},
        ip_address=client_ip(request),
    )
    db.commit()
    return ExamProctorOut(
        id=assignment.id,
        exam_id=assignment.exam_id,
        proctor_user_id=assignment.proctor_user_id,
        proctor_email=proctor.email or proctor.username,
        proctor_full_name=proctor.full_name,
        permissions=payload.permissions,
        created_at=assignment.created_at,
    )


@router.patch("/exams/{exam_id}/proctors/{assignment_id}", response_model=ExamProctorOut)
def update_assignment(
    exam_id: str,
    assignment_id: str,
    payload: ProctorAssignmentUpdate,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ExamProctorOut:
    exam = get_exam_or_404(db, exam_id)
    assignment = db.get(ExamProctor, assignment_id)
    if assignment is None or assignment.exam_id != exam.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Penugasan tidak ditemukan.")

    assignment.can_view_exam = payload.permissions.can_view_exam
    assignment.can_view_participants = payload.permissions.can_view_participants
    assignment.can_start_exam = payload.permissions.can_start_exam
    assignment.can_end_exam = payload.permissions.can_end_exam
    assignment.can_review_incidents = payload.permissions.can_review_incidents
    assignment.can_export_report = payload.permissions.can_export_report
    proctor = db.get(User, assignment.proctor_user_id)
    record_audit(
        db,
        action="exam.proctor_permissions_updated",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"proctor_user_id": assignment.proctor_user_id, "permissions": payload.permissions.model_dump()},
        ip_address=client_ip(request),
    )
    db.commit()
    return ExamProctorOut(
        id=assignment.id,
        exam_id=assignment.exam_id,
        proctor_user_id=assignment.proctor_user_id,
        proctor_email=(proctor.email or proctor.username) if proctor else "",
        proctor_full_name=proctor.full_name if proctor else "",
        permissions=payload.permissions,
        created_at=assignment.created_at,
    )


@router.delete("/exams/{exam_id}/proctors/{assignment_id}", response_model=MessageResponse)
def remove_assignment(
    exam_id: str,
    assignment_id: str,
    admin: AdminUser,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    exam = get_exam_or_404(db, exam_id)
    assignment = db.get(ExamProctor, assignment_id)
    if assignment is None or assignment.exam_id != exam.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Penugasan tidak ditemukan.")
    db.delete(assignment)
    record_audit(
        db,
        action="exam.proctor_unassigned",
        actor=admin,
        resource_type="exam",
        resource_id=exam.id,
        metadata={"proctor_user_id": assignment.proctor_user_id},
        ip_address=client_ip(request),
    )
    db.commit()
    return MessageResponse(message="Penugasan proktor dihapus.")
