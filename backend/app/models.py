"""SQLAlchemy ORM models.

Portable between SQLite (development) and PostgreSQL (production):
- UUID primary keys are stored as 36-char strings.
- Timestamps are timezone-aware UTC.
- JSON columns use the generic ``JSON`` type (JSONB on PostgreSQL).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class UTCDateTime(TypeDecorator):
    """Timezone-aware UTC datetimes on every backend.

    SQLite has no native timezone support: values come back naive, which would
    make a serialized timestamp ambiguous and break client countdowns. This type
    stores naive UTC and always returns timezone-aware UTC values.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)



class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


# ---------------------------------------------------------------------------
# Identity and access
# ---------------------------------------------------------------------------
class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, index=True)  # ADMIN | PROCTOR
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)

    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    exam_assignments: Mapped[list["ExamProctor"]] = relationship(
        back_populates="proctor", cascade="all, delete-orphan"
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    user_agent: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    ip_address: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions")


class AppSetting(Base):
    """Small key/value store for runtime flags (e.g. first-run completion)."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


# ---------------------------------------------------------------------------
# Exams
# ---------------------------------------------------------------------------
class Exam(TimestampMixin, Base):
    __tablename__ = "exams"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    exam_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    google_forms_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    scheduled_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    registration_opens_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    registration_closes_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="DRAFT", index=True)
    created_by: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    roster: Mapped[list["ExamParticipant"]] = relationship(
        back_populates="exam", cascade="all, delete-orphan"
    )
    proctors: Mapped[list["ExamProctor"]] = relationship(
        back_populates="exam", cascade="all, delete-orphan"
    )
    sessions: Mapped[list["ExamSession"]] = relationship(
        back_populates="exam", cascade="all, delete-orphan"
    )


class ExamProctor(Base):
    __tablename__ = "exam_proctors"
    __table_args__ = (UniqueConstraint("exam_id", "proctor_user_id", name="uq_exam_proctor"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    exam_id: Mapped[str] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"), nullable=False, index=True)
    proctor_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    can_view_exam: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_view_participants: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_start_exam: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_end_exam: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_review_incidents: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_export_report: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    exam: Mapped[Exam] = relationship(back_populates="proctors")
    proctor: Mapped[User] = relationship(back_populates="exam_assignments")


# ---------------------------------------------------------------------------
# Participants
# ---------------------------------------------------------------------------
class Participant(TimestampMixin, Base):
    __tablename__ = "participants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # NPM is optional informational data. It is NOT used for identity validation
    # and deliberately has no unique constraint.
    npm: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    exam_links: Mapped[list["ExamParticipant"]] = relationship(
        back_populates="participant", cascade="all, delete-orphan"
    )


class ExamParticipant(Base):
    __tablename__ = "exam_participants"
    __table_args__ = (
        UniqueConstraint("exam_id", "participant_id", name="uq_exam_participant"),
        Index("ix_exam_participants_exam_normname", "exam_id", "normalized_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    exam_id: Mapped[str] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"), nullable=False, index=True)
    participant_id: Mapped[str] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Denormalized copy of participants.normalized_name so roster uniqueness is
    # enforceable per exam in a single query.
    normalized_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    group_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    exam: Mapped[Exam] = relationship(back_populates="roster")
    participant: Mapped[Participant] = relationship(back_populates="exam_links")


class ParticipantIdentity(Base):
    """Optional external identity binding (Google OIDC ``sub``) when enabled."""

    __tablename__ = "participant_google_identities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    participant_id: Mapped[str] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    google_subject: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    google_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    last_verified_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)


# ---------------------------------------------------------------------------
# Exam sessions and participant sessions
# ---------------------------------------------------------------------------
class ExamSession(Base):
    __tablename__ = "exam_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    exam_id: Mapped[str] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"), nullable=False, index=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    ends_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True, index=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    started_by: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    ended_by: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="WAITING", index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    exam: Mapped[Exam] = relationship(back_populates="sessions")
    participant_sessions: Mapped[list["ParticipantSession"]] = relationship(
        back_populates="exam_session", cascade="all, delete-orphan"
    )


class ParticipantSession(Base):
    __tablename__ = "participant_sessions"
    __table_args__ = (
        Index("ix_participant_sessions_session_participant", "exam_session_id", "participant_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    exam_session_id: Mapped[str] = mapped_column(
        ForeignKey("exam_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    participant_id: Mapped[str] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    identity_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("participant_google_identities.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="REGISTERED", index=True)
    commitment_accepted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    commitment_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    commitment_accepted_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    # NPM captured at registration time (informational only).
    npm_reported: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # SHA-256 hash of the opaque participant access token (never the raw token).
    access_token_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    connected_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    last_heartbeat_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    disconnected_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    connection_lost_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    exam_session: Mapped[ExamSession] = relationship(back_populates="participant_sessions")
    participant: Mapped[Participant] = relationship()
    events: Mapped[list["MonitoringEvent"]] = relationship(
        back_populates="participant_session", cascade="all, delete-orphan"
    )
    incidents: Mapped[list["ViolationIncident"]] = relationship(
        back_populates="participant_session", cascade="all, delete-orphan"
    )


# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------
class MonitoringEvent(Base):
    __tablename__ = "monitoring_events"
    __table_args__ = (
        UniqueConstraint("participant_session_id", "client_event_id", name="uq_monitoring_event_client_id"),
        Index("ix_monitoring_events_session_received", "participant_session_id", "received_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    participant_session_id: Mapped[str] = mapped_column(
        ForeignKey("participant_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    event_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    client_timestamp: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    tab_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    window_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    page_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    page_host: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, nullable=False, default=dict)
    extension_version: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    incident_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("violation_incidents.id", ondelete="SET NULL"), nullable=True, index=True
    )

    participant_session: Mapped[ParticipantSession] = relationship(back_populates="events")


class ViolationIncident(Base):
    __tablename__ = "violation_incidents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    participant_session_id: Mapped[str] = mapped_column(
        ForeignKey("participant_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    incident_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    ended_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    review_status: Mapped[str] = mapped_column(String(32), nullable=False, default="UNREVIEWED", index=True)
    reviewed_by: Mapped[Optional[str]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime(), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    participant_session: Mapped[ParticipantSession] = relationship(back_populates="incidents")


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------
class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_logs_created", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    actor_user_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    actor_label: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    action: Mapped[str] = mapped_column(String(96), nullable=False, index=True)
    resource_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    resource_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, nullable=False, default=dict)
    ip_address: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


__all__ = [
    "utcnow",
    "new_uuid",
    "User",
    "AuthSession",
    "AppSetting",
    "Exam",
    "ExamProctor",
    "Participant",
    "ExamParticipant",
    "ParticipantIdentity",
    "ExamSession",
    "ParticipantSession",
    "MonitoringEvent",
    "ViolationIncident",
    "AuditLog",
]
