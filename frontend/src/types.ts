export type Role = "ADMIN" | "PROCTOR";

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface ProctorPermissions {
  can_view_exam: boolean;
  can_view_participants: boolean;
  can_start_exam: boolean;
  can_end_exam: boolean;
  can_review_incidents: boolean;
  can_export_report: boolean;
}

export interface Permissions {
  role: Role;
  is_admin: boolean;
  exams: { exam_id: string; permissions: ProctorPermissions }[];
  global: {
    manage_users: boolean;
    manage_exams: boolean;
    manage_roster: boolean;
    review_incidents: boolean;
    export_report: boolean;
    view_audit: boolean;
    manage_settings: boolean;
  };
}

export interface MeResponse {
  user: User;
  csrf_token: string;
  permissions: Permissions;
}

export type ExamStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "REGISTRATION_OPEN"
  | "WAITING"
  | "STARTING"
  | "LIVE"
  | "COMPLETED"
  | "CANCELLED";

export interface Exam {
  id: string;
  exam_code: string;
  name: string;
  description: string | null;
  google_forms_url: string | null;
  scheduled_at: string | null;
  duration_minutes: number;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  status: ExamStatus;
  created_at: string;
  updated_at: string;
  participant_count: number;
  incident_count: number;
  proctor_count: number;
  exam_session_id: string | null;
  session_status: string | null;
  started_at: string | null;
  ends_at: string | null;
  server_time: string | null;
}

export interface RosterEntry {
  id: string;
  participant_id: string;
  exam_id: string;
  full_name: string;
  normalized_name: string;
  npm: string | null;
  email: string | null;
  group_name: string | null;
  notes: string | null;
  created_at: string;
  participant_session_status: string | null;
  incident_count: number;
}

export interface RosterImportRow {
  row_number: number;
  full_name: string;
  npm: string | null;
  email: string | null;
  group_name: string | null;
  normalized_name: string;
  status: string;
  message: string | null;
}

export interface RosterImportPreview {
  rows: RosterImportRow[];
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  error_rows: number;
}

export interface Proctor {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
  assigned_exam_count: number;
}

export interface ExamProctorAssignment {
  id: string;
  exam_id: string;
  proctor_user_id: string;
  proctor_email: string;
  proctor_full_name: string;
  permissions: ProctorPermissions;
  created_at: string;
}

export interface ParticipantCard {
  participant_session_id: string;
  participant_id: string;
  full_name: string;
  npm: string | null;
  group_name: string | null;
  status: string;
  connection_state: string;
  online: boolean;
  incident_count: number;
  last_activity_at: string | null;
  latest_event_summary: string | null;
  last_heartbeat_at: string | null;
  connected_at: string | null;
}

export interface MonitoringEvent {
  id: string;
  event_type: string;
  client_timestamp: string | null;
  received_at: string;
  tab_id: number | null;
  window_id: number | null;
  page_host: string | null;
  metadata_json: Record<string, unknown>;
  incident_id: string | null;
}

export interface Incident {
  id: string;
  participant_session_id: string;
  incident_type: string;
  started_at: string;
  ended_at: string | null;
  event_count: number;
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface ParticipantDetail extends ParticipantCard {
  commitment: {
    accepted: boolean;
    version: string | null;
    accepted_at: string | null;
    npm_reported: string | null;
  };
  events: MonitoringEvent[];
  incidents: Incident[];
}

export interface OverviewStats {
  total_exams: number;
  active_exams: number;
  total_participants: number;
  online_participants: number;
  offline_participants: number;
  total_incidents: number;
  unreviewed_incidents: number;
}

export interface AuditLog {
  id: string;
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata_json: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface ExamTimer {
  exam_id: string;
  exam_session_id?: string;
  status: ExamStatus;
  session_status?: string;
  server_time: string;
  started_at: string | null;
  ends_at: string | null;
  remaining_seconds: number;
}

export interface ParticipantConfig {
  google_auth_required: boolean;
  commitment_version: string;
  heartbeat_interval_seconds: number;
  google_client_id: string | null;
  integrity_commitment: string;
}

export interface ParticipantSession {
  participant_session_id: string;
  exam_id: string;
  exam_code: string;
  exam_name: string;
  exam_status: ExamStatus;
  participant: {
    full_name: string;
    npm: string | null;
    group_name: string | null;
  };
  status: string;
  connection_state: string;
  commitment: {
    accepted: boolean;
    version: string | null;
    accepted_at: string | null;
  };
  started_at: string | null;
  ends_at: string | null;
  server_time: string;
  google_forms_url: string | null;
  heartbeat_interval_seconds: number;
  messages: string[];
}

export interface PublicExamInfo {
  exam_code: string;
  name: string;
  status: ExamStatus;
  duration_minutes: number;
  registration_open: boolean;
  registration_message: string | null;
  scheduled_at: string | null;
  server_time: string;
}
