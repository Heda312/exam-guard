"""Pydantic request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Auth ------------------------------------------------------------------
class SetupStatus(BaseModel):
    setup_required: bool
    setup_secret_configured: bool


class FirstRunSetupRequest(BaseModel):
    setup_secret: str = Field(min_length=1)
    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=2, max_length=255)
    password: str = Field(min_length=8, max_length=200)


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=200)


class UserOut(ORMModel):
    id: str
    username: str
    email: Optional[str] = None
    full_name: str
    role: str
    is_active: bool
    must_change_password: bool
    created_at: datetime
    last_login_at: Optional[datetime] = None


class MeResponse(BaseModel):
    user: UserOut
    csrf_token: str
    permissions: dict[str, Any]


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


# --- Exams -----------------------------------------------------------------
class ExamCreate(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    exam_code: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = None
    google_forms_url: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    duration_minutes: int = Field(default=90, ge=1, le=600)
    registration_opens_at: Optional[datetime] = None
    registration_closes_at: Optional[datetime] = None
    status: Literal[
        "DRAFT", "SCHEDULED", "REGISTRATION_OPEN", "WAITING", "STARTING", "LIVE", "COMPLETED", "CANCELLED"
    ] = "DRAFT"


class ExamUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=255)
    description: Optional[str] = None
    google_forms_url: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    duration_minutes: Optional[int] = Field(default=None, ge=1, le=600)
    registration_opens_at: Optional[datetime] = None
    registration_closes_at: Optional[datetime] = None


class ExamStatusUpdate(BaseModel):
    status: Literal[
        "DRAFT", "SCHEDULED", "REGISTRATION_OPEN", "WAITING", "STARTING", "LIVE", "COMPLETED", "CANCELLED"
    ]


class ExamOut(ORMModel):
    id: str
    exam_code: str
    name: str
    description: Optional[str]
    google_forms_url: Optional[str]
    scheduled_at: Optional[datetime]
    duration_minutes: int
    registration_opens_at: Optional[datetime]
    registration_closes_at: Optional[datetime]
    status: str
    created_at: datetime
    updated_at: datetime


class ExamSummaryOut(ExamOut):
    participant_count: int = 0
    incident_count: int = 0
    proctor_count: int = 0
    exam_session_id: Optional[str] = None
    session_status: Optional[str] = None
    started_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    server_time: Optional[datetime] = None


# --- Proctors --------------------------------------------------------------
class ProctorPermissions(BaseModel):
    can_view_exam: bool = True
    can_view_participants: bool = True
    can_start_exam: bool = False
    can_end_exam: bool = False
    can_review_incidents: bool = True
    can_export_report: bool = False


class ProctorCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=2, max_length=255)
    password: str = Field(min_length=8, max_length=200)
    permissions: ProctorPermissions = Field(default_factory=ProctorPermissions)


class ProctorUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=2, max_length=255)
    username: Optional[str] = Field(default=None, min_length=3, max_length=64)
    is_active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=8, max_length=200)


class AdminUserIn(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=2, max_length=255)
    password: str = Field(min_length=8, max_length=200)


class AdminUserOut(UserOut):
    pass


class ProctorOut(UserOut):
    assigned_exam_count: int = 0


class UserList(BaseModel):
    users: list[AdminUserOut]
    proctors: list[ProctorOut] = []


class ProctorAssignment(BaseModel):
    proctor_user_id: str
    permissions: ProctorPermissions = Field(default_factory=ProctorPermissions)


class ProctorAssignmentUpdate(BaseModel):
    permissions: ProctorPermissions


class ExamProctorOut(BaseModel):
    id: str
    exam_id: str
    proctor_user_id: str
    proctor_email: str
    proctor_full_name: str
    permissions: ProctorPermissions
    created_at: datetime


# --- Participants ----------------------------------------------------------
class RosterEntryCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=255)
    npm: Optional[str] = Field(default=None, max_length=64)
    email: Optional[EmailStr] = None
    group_name: Optional[str] = Field(default=None, max_length=128)
    notes: Optional[str] = None


class RosterEntryUpdate(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    npm: Optional[str] = Field(default=None, max_length=64)
    email: Optional[EmailStr] = None
    group_name: Optional[str] = Field(default=None, max_length=128)
    notes: Optional[str] = None


class RosterEntryOut(BaseModel):
    id: str
    participant_id: str
    exam_id: str
    full_name: str
    normalized_name: str
    npm: Optional[str]
    email: Optional[str]
    group_name: Optional[str]
    notes: Optional[str]
    created_at: datetime
    participant_session_status: Optional[str] = None
    incident_count: int = 0


class RosterImportRow(BaseModel):
    row_number: int
    full_name: str
    npm: Optional[str] = None
    email: Optional[str] = None
    group_name: Optional[str] = None
    normalized_name: str
    status: str  # ok | duplicate_in_file | duplicate_in_roster | invalid
    message: Optional[str] = None


class RosterImportPreview(BaseModel):
    rows: list[RosterImportRow]
    total_rows: int
    valid_rows: int
    warning_rows: int
    error_rows: int


class RosterImportCommitResult(BaseModel):
    imported: int
    skipped: int
    errors: list[RosterImportRow]


class RosterImportErrorReportRequest(BaseModel):
    rows: list[RosterImportRow]


# --- Participant registration ---------------------------------------------
class ParticipantRegisterRequest(BaseModel):
    exam_code: str = Field(min_length=1, max_length=64)
    full_name: str = Field(min_length=1, max_length=255)
    npm: Optional[str] = Field(default=None, max_length=64)
    commitment_accepted: bool
    commitment_version: Optional[str] = None
    # Only used when participant_identity_mode == "google".
    google_id_token: Optional[str] = None

    @field_validator("exam_code")
    @classmethod
    def _strip_code(cls, value: str) -> str:
        return value.strip()

    @field_validator("full_name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        return value.strip()


class ParticipantSessionOut(BaseModel):
    participant_session_id: str
    exam_id: str
    exam_code: str
    exam_name: str
    exam_status: str
    participant: dict[str, Any]
    status: str
    connection_state: str
    commitment: dict[str, Any]
    started_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    server_time: datetime
    google_forms_url: Optional[str] = None
    heartbeat_interval_seconds: int
    messages: list[str] = Field(default_factory=list)


class HeartbeatRequest(BaseModel):
    participant_session_id: str


class HeartbeatResponse(BaseModel):
    message: str
    status: str
    remaining_seconds: int = 0
    ends_at: Optional[datetime] = None


class ReadyRequest(BaseModel):
    participant_session_id: str
    page_url: Optional[str] = None


class ReconnectRequest(BaseModel):
    participant_session_id: str


# --- Monitoring ------------------------------------------------------------
class MonitoringEventIn(BaseModel):
    client_event_id: Optional[str] = Field(default=None, max_length=64)
    event_type: Literal[
        "TAB_SWITCH",
        "NEW_TAB",
        "TAB_CLOSED",
        "FOCUS_LOST",
        "WINDOW_MINIMIZED",
        "NAVIGATION",
        "CONNECTION_LOST",
        "FOCUS_RESTORED",
    ]
    client_timestamp: Optional[datetime] = None
    tab_id: Optional[int] = None
    window_id: Optional[int] = None
    page_url: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    extension_version: Optional[str] = Field(default=None, max_length=32)


class MonitoringEventOut(ORMModel):
    id: str
    event_type: str
    client_timestamp: Optional[datetime]
    received_at: datetime
    tab_id: Optional[int]
    window_id: Optional[int]
    page_host: Optional[str]
    metadata_json: dict[str, Any]
    incident_id: Optional[str]


class IncidentOut(ORMModel):
    id: str
    participant_session_id: str
    incident_type: str
    started_at: datetime
    ended_at: Optional[datetime]
    event_count: int
    review_status: str
    reviewed_by: Optional[str]
    reviewed_at: Optional[datetime]
    notes: Optional[str]
    created_at: datetime
    # Host the participant was on when the episode started. Derived from the
    # latest event of the incident, so the incident table can show the domain
    # instead of only the cards.
    page_host: Optional[str] = None
    participant_name: Optional[str] = None


class IncidentReviewRequest(BaseModel):
    review_status: Literal["UNREVIEWED", "REVIEWED", "FLAGGED_FOR_FOLLOWUP"]
    notes: Optional[str] = Field(default=None, max_length=2000)


class ParticipantCard(BaseModel):
    participant_session_id: str
    participant_id: str
    full_name: str
    npm: Optional[str]
    group_name: Optional[str]
    status: str
    connection_state: str
    online: bool
    incident_count: int
    last_incident_at: Optional[datetime] = None
    last_incident_type: Optional[str] = None
    last_activity_at: Optional[datetime]
    latest_event_summary: Optional[str]
    last_heartbeat_at: Optional[datetime]
    connected_at: Optional[datetime]
    # Set when the participant joined after the exam had already started. Shown
    # as a badge on the card; it never blocks them from taking the exam.
    is_late: bool = False
    joined_at: Optional[datetime] = None


class ParticipantDetail(ParticipantCard):
    commitment: dict[str, Any]
    events: list[MonitoringEventOut]
    incidents: list[IncidentOut]


class MonitoringTimerOut(BaseModel):
    exam_id: str
    exam_session_id: Optional[str] = None
    status: str
    session_status: Optional[str] = None
    server_time: datetime
    started_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    remaining_seconds: int = 0


class ProctorPresence(BaseModel):
    """A staff member currently holding a live dashboard socket for the exam."""

    user_id: str
    full_name: str


class MonitoringStateOut(BaseModel):
    """Single payload for the live monitoring dashboard.

    Bundling cards, incidents and the timer removes two extra HTTP round-trips
    per refresh (and per WebSocket burst) compared with calling three endpoints.
    """

    cards: list[ParticipantCard]
    incidents: list[IncidentOut]
    timer: MonitoringTimerOut
    server_time: datetime
    proctors_online: list[ProctorPresence] = []


# --- Dashboard -------------------------------------------------------------
class OverviewStats(BaseModel):
    total_exams: int
    active_exams: int
    total_participants: int
    online_participants: int
    offline_participants: int
    total_incidents: int
    unreviewed_incidents: int


class AuditLogOut(ORMModel):
    id: str
    actor_user_id: Optional[str]
    actor_label: Optional[str]
    action: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    metadata_json: dict[str, Any]
    ip_address: Optional[str]
    created_at: datetime


class MessageResponse(BaseModel):
    message: str
