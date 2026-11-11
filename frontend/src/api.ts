/**
 * Typed API client.
 *
 * - Admin/proctor calls use the HttpOnly session cookie plus the CSRF header.
 * - Participant calls use the scoped participant token.
 */

const BASE = "/api/v1";

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : "Terjadi kesalahan pada permintaan.");
    this.status = status;
    this.detail = detail;
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const record = detail as Record<string, unknown>;
      if (typeof record.message === "string") return record.message;
      if (Array.isArray(record)) {
        const first = record[0] as Record<string, unknown> | undefined;
        if (first && typeof first.msg === "string") return first.msg;
      }
    }
    return `Permintaan gagal (${error.status}).`;
  }
  if (error instanceof Error) return error.message;
  return "Terjadi kesalahan tak terduga.";
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, headers = {}, raw = false } = options;
  const isFormData = body instanceof FormData;

  const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  if (body !== undefined && !isFormData) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("eg_csrf");
    if (csrf) finalHeaders["X-CSRF-Token"] = csrf;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: finalHeaders,
    credentials: "include",
    signal,
    body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const data = await response.json();
      detail = data.detail ?? data;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, detail);
  }

  if (raw) return response as unknown as T;
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/* ------------------------------ Auth ------------------------------ */
export interface SetupStatus {
  setup_required: boolean;
  setup_secret_configured: boolean;
}

export const api = {
  setupStatus: () => request<SetupStatus>("/setup/status"),
  setup: (payload: { setup_secret: string; username: string; full_name: string; password: string }) =>
    request<import("./types").MeResponse>("/setup", { method: "POST", body: payload }),
  login: (payload: { username: string; password: string }) =>
    request<import("./types").MeResponse>("/auth/login", { method: "POST", body: payload }),
  me: () => request<import("./types").MeResponse>("/auth/me"),
  logout: () => request<{ message: string }>("/auth/logout", { method: "POST" }),
  changePassword: (payload: { current_password: string; new_password: string }) =>
    request<{ message: string }>("/auth/change-password", { method: "POST", body: payload }),

  /* ---------------------------- Exams ---------------------------- */
  listExams: () => request<import("./types").Exam[]>("/exams"),
  getExam: (id: string) => request<import("./types").Exam>(`/exams/${id}`),
  createExam: (payload: Record<string, unknown>) =>
    request<import("./types").Exam>("/exams", { method: "POST", body: payload }),
  updateExam: (id: string, payload: Record<string, unknown>) =>
    request<import("./types").Exam>(`/exams/${id}`, { method: "PATCH", body: payload }),
  changeExamStatus: (id: string, status: string) =>
    request<import("./types").Exam>(`/exams/${id}/status`, { method: "POST", body: { status } }),
  validateFormUrl: (id: string, url: string) =>
    request<{ valid: boolean; url: string; host: string }>(`/exams/${id}/validate-form-url`, {
      method: "POST",
      body: { url },
    }),
  startExam: (id: string) =>
    request<import("./types").Exam>(`/exams/${id}/start`, { method: "POST" }),
  endExam: (id: string) => request<import("./types").Exam>(`/exams/${id}/end`, { method: "POST" }),
  examTimer: (id: string) => request<import("./types").ExamTimer>(`/exams/${id}/timer`),

  /* ---------------------------- Roster --------------------------- */
  listRoster: (examId: string, search?: string) =>
    request<import("./types").RosterEntry[]>(
      `/exams/${examId}/roster${search ? `?search=${encodeURIComponent(search)}` : ""}`,
    ),
  addRosterEntry: (examId: string, payload: Record<string, unknown>) =>
    request<import("./types").RosterEntry>(`/exams/${examId}/roster`, { method: "POST", body: payload }),
  updateRosterEntry: (examId: string, entryId: string, payload: Record<string, unknown>) =>
    request<import("./types").RosterEntry>(`/exams/${examId}/roster/${entryId}`, {
      method: "PATCH",
      body: payload,
    }),
  deleteRosterEntry: (examId: string, entryId: string) =>
    request<{ message: string }>(`/exams/${examId}/roster/${entryId}`, { method: "DELETE" }),
  previewImport: (examId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<import("./types").RosterImportPreview>(`/exams/${examId}/roster/import/preview`, {
      method: "POST",
      body: form,
    });
  },
  commitImport: (examId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ imported: number; skipped: number; errors: import("./types").RosterImportRow[] }>(
      `/exams/${examId}/roster/import`,
      { method: "POST", body: form },
    );
  },
  importTemplateUrl: (examId: string) => `${BASE}/exams/${examId}/roster/import/template`,
  downloadImportErrorReport: (examId: string, rows: import("./types").RosterImportRow[]) =>
    request<Response>(`/exams/${examId}/roster/import/error-report`, {
      method: "POST",
      body: { rows },
      raw: true,
    }).then((r) => r.blob()),

  /* --------------------------- Proctors -------------------------- */
  listProctors: () => request<import("./types").Proctor[]>("/admin/proctors"),
  createProctor: (payload: Record<string, unknown>) =>
    request<import("./types").Proctor>("/admin/proctors", { method: "POST", body: payload }),
  updateProctor: (id: string, payload: Record<string, unknown>) =>
    request<import("./types").Proctor>(`/admin/proctors/${id}`, { method: "PATCH", body: payload }),
  deactivateProctor: (id: string) =>
    request<{ message: string }>(`/admin/proctors/${id}`, { method: "DELETE" }),
  deleteProctor: (id: string) =>
    request<{ message: string }>(`/admin/proctors/${id}`, { method: "DELETE" }),
  deleteExam: (examId: string) =>
    request<{ message: string }>(`/exams/${examId}`, { method: "DELETE" }),
  removeRosterEntry: (examId: string, entryId: string) =>
    request<{ message: string }>(`/exams/${examId}/roster/${entryId}`, { method: "DELETE" }),
  listExamProctors: (examId: string) =>
    request<import("./types").ExamProctorAssignment[]>(`/admin/exams/${examId}/proctors`),
  assignProctor: (examId: string, payload: { proctor_user_id: string; permissions: Record<string, boolean> }) =>
    request<import("./types").ExamProctorAssignment>(`/admin/exams/${examId}/proctors`, {
      method: "POST",
      body: payload,
    }),
  updateAssignment: (examId: string, assignmentId: string, permissions: Record<string, boolean>) =>
    request<import("./types").ExamProctorAssignment>(
      `/admin/exams/${examId}/proctors/${assignmentId}`,
      { method: "PATCH", body: { permissions } },
    ),
  removeAssignment: (examId: string, assignmentId: string) =>
    request<{ message: string }>(`/admin/exams/${examId}/proctors/${assignmentId}`, {
      method: "DELETE",
    }),

  /* -------------------------- Monitoring ------------------------- */
  overview: () => request<import("./types").OverviewStats>("/dashboard/overview"),
  monitor: (examId: string) =>
    request<import("./types").ParticipantCard[]>(`/exams/${examId}/monitor`),
  monitorState: (examId: string) =>
    request<import("./types").MonitoringState>(`/exams/${examId}/monitor/state`),
  participantDetail: (participantSessionId: string) =>
    request<import("./types").ParticipantDetail>(`/participant-sessions/${participantSessionId}`),
  listIncidents: (examId: string, reviewStatus?: string) =>
    request<import("./types").Incident[]>(
      `/exams/${examId}/incidents${reviewStatus ? `?review_status=${reviewStatus}` : ""}`,
    ),
  reviewIncident: (incidentId: string, payload: { review_status: string; notes?: string }) =>
    request<import("./types").Incident>(`/incidents/${incidentId}`, { method: "PATCH", body: payload }),
  auditLogs: (limit = 100) => request<import("./types").AuditLog[]>(`/audit-logs?limit=${limit}`),

  /* --------------------------- Reports --------------------------- */
  reportUrl: (examId: string, format: "csv" | "xlsx") => `${BASE}/exams/${examId}/report.${format}`,
};

/* --------------------------- Participant -------------------------- */
const PARTICIPANT_TOKEN_KEY = "examguard.participant.token";
const PARTICIPANT_SESSION_KEY = "examguard.participant.session";

export const participantStore = {
  save(sessionId: string, token: string) {
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, token);
    localStorage.setItem(PARTICIPANT_SESSION_KEY, sessionId);
  },
  token(): string | null {
    return localStorage.getItem(PARTICIPANT_TOKEN_KEY);
  },
  sessionId(): string | null {
    return localStorage.getItem(PARTICIPANT_SESSION_KEY);
  },
  clear() {
    localStorage.removeItem(PARTICIPANT_TOKEN_KEY);
    localStorage.removeItem(PARTICIPANT_SESSION_KEY);
  },
};

async function participantRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = participantStore.token();
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { "X-Participant-Token": token } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const data = await response.json();
      detail = data.detail ?? data;
    } catch {
      /* ignore */
    }
    throw new ApiError(response.status, detail);
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const participantApi = {
  config: () => participantRequest<import("./types").ParticipantConfig>("/participant/config"),
  publicExam: (examCode: string) =>
    participantRequest<import("./types").PublicExamInfo>(
      `/participant/exam/${encodeURIComponent(examCode)}/public`,
    ),
  register: async (payload: Record<string, unknown>) => {
    const token = participantStore.token();
    const response = await fetch(`${BASE}/participant/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { "X-Participant-Token": token } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let detail: unknown = response.statusText;
      try {
        const data = await response.json();
        detail = data.detail ?? data;
      } catch {
        /* ignore */
      }
      throw new ApiError(response.status, detail);
    }
    const issued = response.headers.get("X-Participant-Token");
    const body = (await response.json()) as import("./types").ParticipantSession;
    if (issued) participantStore.save(body.participant_session_id, issued);
    return body;
  },
  session: (participantSessionId: string) =>
    participantRequest<import("./types").ParticipantSession>("/participant/session", {
      method: "POST",
      body: { participant_session_id: participantSessionId },
    }),
  ready: (participantSessionId: string, pageUrl?: string) =>
    participantRequest<import("./types").ParticipantSession>("/participant/ready", {
      method: "POST",
      body: { participant_session_id: participantSessionId, page_url: pageUrl },
    }),
  startMonitoring: (participantSessionId: string) =>
    participantRequest<import("./types").ParticipantSession>("/participant/monitoring/start", {
      method: "POST",
      body: { participant_session_id: participantSessionId },
    }),
  heartbeat: (participantSessionId: string) =>
    participantRequest<import("./types").HeartbeatAck>("/participant/heartbeat", {
      method: "POST",
      body: { participant_session_id: participantSessionId },
    }),
  disconnect: (participantSessionId: string) =>
    participantRequest<{ message: string }>("/participant/disconnect", {
      method: "POST",
      body: { participant_session_id: participantSessionId },
    }),
  submitEvents: (participantSessionId: string, events: Record<string, unknown>[]) =>
    participantRequest<unknown[]>(`/participant/events?participant_session_id=${participantSessionId}`, {
      method: "POST",
      body: events,
    }),
};
