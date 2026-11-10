"""Participant roster and CSV import (spec §9)."""
from __future__ import annotations

import csv
import io
from typing import Iterable, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Exam, ExamParticipant, Participant, utcnow
from ..names import clean_display_name, normalize_name
from ..schemas import RosterImportRow

REQUIRED_COLUMNS = ("full_name",)
OPTIONAL_COLUMNS = ("npm", "email", "group_name")
ALL_COLUMNS = REQUIRED_COLUMNS + OPTIONAL_COLUMNS


class RosterError(Exception):
    pass


def find_roster_matches(db: Session, exam_id: str, normalized: str) -> list[ExamParticipant]:
    return list(
        db.scalars(
            select(ExamParticipant).where(
                ExamParticipant.exam_id == exam_id,
                ExamParticipant.normalized_name == normalized,
            )
        ).all()
    )


def roster_normalized_names(db: Session, exam_id: str) -> set[str]:
    return set(
        db.scalars(select(ExamParticipant.normalized_name).where(ExamParticipant.exam_id == exam_id)).all()
    )


def create_roster_entry(
    db: Session,
    exam: Exam,
    *,
    full_name: str,
    npm: Optional[str] = None,
    email: Optional[str] = None,
    group_name: Optional[str] = None,
    notes: Optional[str] = None,
) -> ExamParticipant:
    display_name = clean_display_name(full_name)
    normalized = normalize_name(display_name)
    if not normalized:
        raise RosterError("Nama peserta wajib diisi.")
    if find_roster_matches(db, exam.id, normalized):
        raise RosterError(
            f"Nama '{display_name}' sudah ada di roster ujian ini (setelah normalisasi)."
        )

    participant = Participant(
        full_name=display_name,
        normalized_name=normalized,
        npm=(npm.strip() if npm and npm.strip() else None),
        email=(email.strip() if email and email.strip() else None),
        notes=notes,
    )
    db.add(participant)
    db.flush()

    link = ExamParticipant(
        exam_id=exam.id,
        participant_id=participant.id,
        normalized_name=normalized,
        group_name=(group_name.strip() if group_name and group_name.strip() else None),
    )
    db.add(link)
    db.flush()
    return link


def update_roster_entry(db: Session, link: ExamParticipant, **changes) -> ExamParticipant:
    participant = link.participant
    if "full_name" in changes and changes["full_name"]:
        display_name = clean_display_name(changes["full_name"])
        normalized = normalize_name(display_name)
        if not normalized:
            raise RosterError("Nama peserta wajib diisi.")
        clash = [
            item
            for item in find_roster_matches(db, link.exam_id, normalized)
            if item.id != link.id
        ]
        if clash:
            raise RosterError("Nama tersebut sudah ada di roster ujian ini.")
        participant.full_name = display_name
        participant.normalized_name = normalized
        link.normalized_name = normalized
    if "npm" in changes:
        value = changes["npm"]
        participant.npm = value.strip() if value and value.strip() else None
    if "email" in changes:
        value = changes["email"]
        participant.email = value.strip() if value and value.strip() else None
    if "notes" in changes:
        participant.notes = changes["notes"]
    if "group_name" in changes:
        value = changes["group_name"]
        link.group_name = value.strip() if value and value.strip() else None
    db.flush()
    return link


def delete_roster_entry(db: Session, link: ExamParticipant) -> None:
    db.delete(link)
    db.flush()


def _read_csv_rows(content: bytes) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RosterError("Berkas CSV harus menggunakan encoding UTF-8.") from exc

    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except csv.Error:
        dialect = csv.excel

    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if reader.fieldnames is None:
        raise RosterError("Berkas CSV tidak memiliki baris header.")
    headers = [h.strip().lower() for h in reader.fieldnames]
    missing = [col for col in REQUIRED_COLUMNS if col not in headers]
    if missing:
        raise RosterError(
            "Kolom wajib tidak ditemukan: " + ", ".join(missing) + ". Kolom yang didukung: "
            + ", ".join(ALL_COLUMNS)
        )
    rows: list[tuple[int, dict[str, str]]] = []
    for index, raw in enumerate(reader, start=2):
        cleaned = {
            (key or "").strip().lower(): (value or "").strip()
            for key, value in raw.items()
            if key is not None
        }
        rows.append((index, cleaned))
    return headers, rows


def build_import_preview(db: Session, exam: Exam, content: bytes) -> list[RosterImportRow]:
    """Validate a CSV without touching the database (spec §9.2)."""
    _, rows = _read_csv_rows(content)
    existing = roster_normalized_names(db, exam.id)
    seen_in_file: dict[str, int] = {}
    seen_npm: dict[str, int] = {}
    results: list[RosterImportRow] = []

    for row_number, row in rows:
        full_name = clean_display_name(row.get("full_name", ""))
        npm = row.get("npm") or None
        email = row.get("email") or None
        group_name = row.get("group_name") or None
        normalized = normalize_name(full_name)

        status = "ok"
        message: Optional[str] = None

        if not full_name:
            status = "invalid"
            message = "Nama lengkap kosong."
        elif not normalized:
            status = "invalid"
            message = "Nama lengkap tidak valid."
        elif normalized in existing:
            status = "duplicate_in_roster"
            message = "Nama sudah terdaftar pada roster ujian ini."
        elif normalized in seen_in_file:
            status = "duplicate_in_file"
            message = f"Duplikat nama pada baris {seen_in_file[normalized]}."
        else:
            seen_in_file[normalized] = row_number
            if npm:
                if npm in seen_npm:
                    # Informational warning only; does not block the import.
                    message = f"Peringatan: NPM juga muncul di baris {seen_npm[npm]} (boleh)."
                else:
                    seen_npm[npm] = row_number

        results.append(
            RosterImportRow(
                row_number=row_number,
                full_name=full_name,
                npm=npm,
                email=email,
                group_name=group_name,
                normalized_name=normalized,
                status=status,
                message=message,
            )
        )
    return results


def commit_import(
    db: Session, exam: Exam, content: bytes
) -> tuple[int, int, list[RosterImportRow]]:
    preview = build_import_preview(db, exam, content)
    imported = 0
    skipped = 0
    errors: list[RosterImportRow] = []

    for row in preview:
        if row.status != "ok":
            skipped += 1
            if row.status != "ok":
                errors.append(row)
            continue
        try:
            create_roster_entry(
                db,
                exam,
                full_name=row.full_name,
                npm=row.npm,
                email=row.email,
                group_name=row.group_name,
            )
            imported += 1
        except RosterError as exc:
            skipped += 1
            errors.append(row.model_copy(update={"status": "invalid", "message": str(exc)}))
    return imported, skipped, errors


def error_report_csv(rows: Iterable[RosterImportRow]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["row_number", "full_name", "npm", "email", "group_name", "status", "message"])
    for row in rows:
        writer.writerow(
            [row.row_number, row.full_name, row.npm or "", row.email or "", row.group_name or "", row.status, row.message or ""]
        )
    return buffer.getvalue()


def roster_count(db: Session, exam_id: str) -> int:
    return int(
        db.scalar(select(func.count(ExamParticipant.id)).where(ExamParticipant.exam_id == exam_id)) or 0
    )


def roster_duplicates(db: Session, exam_id: str) -> list[str]:
    rows = db.execute(
        select(ExamParticipant.normalized_name, func.count(ExamParticipant.id))
        .where(ExamParticipant.exam_id == exam_id)
        .group_by(ExamParticipant.normalized_name)
        .having(func.count(ExamParticipant.id) > 1)
    ).all()
    return [row[0] for row in rows]
