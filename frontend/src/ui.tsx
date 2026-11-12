/** Shared UI primitives for the ExamGuard design system. */
import type { ReactNode } from "react";
import type { ExamStatus } from "./types";

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "online" | "offline" | "danger" | "warning" | "success" | "live";
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

const EXAM_STATUS_LABEL: Record<ExamStatus, string> = {
  DRAFT: "Draf",
  SCHEDULED: "Terjadwal",
  REGISTRATION_OPEN: "Pendaftaran dibuka",
  WAITING: "Menunggu",
  STARTING: "Memulai",
  LIVE: "Berlangsung",
  COMPLETED: "Selesai",
  CANCELLED: "Dibatalkan",
};

const EXAM_STATUS_TONE: Record<ExamStatus, "neutral" | "success" | "warning" | "live" | "danger"> = {
  DRAFT: "neutral",
  SCHEDULED: "neutral",
  REGISTRATION_OPEN: "success",
  WAITING: "warning",
  STARTING: "warning",
  LIVE: "live",
  COMPLETED: "neutral",
  CANCELLED: "danger",
};

export function ExamStatusBadge({ status }: { status: ExamStatus }) {
  return (
    <Badge tone={EXAM_STATUS_TONE[status] ?? "neutral"} dot={status === "LIVE"}>
      {EXAM_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

const PARTICIPANT_STATUS_LABEL: Record<string, string> = {
  REGISTERED: "Terdaftar",
  WAITING: "Menunggu",
  INITIALIZING: "Menyiapkan",
  READY: "Siap",
  MONITORING: "Dipantau",
  CONNECTION_LOST: "Koneksi terputus",
  COMPLETED: "Selesai",
  TIME_EXPIRED: "Waktu habis",
  CANCELLED: "Dibatalkan",
};

export function participantStatusLabel(status: string): string {
  return PARTICIPANT_STATUS_LABEL[status] ?? status;
}

export function ConnectionBadge({ online, status }: { online: boolean; status: string }) {
  if (status === "CONNECTION_LOST") {
    return (
      <Badge tone="warning" dot>
        Koneksi terputus
      </Badge>
    );
  }
  if (status === "COMPLETED" || status === "TIME_EXPIRED") {
    return <Badge tone="neutral">{participantStatusLabel(status)}</Badge>;
  }
  return (
    <Badge tone={online ? "online" : "offline"} dot>
      {online ? "Online" : "Offline"}
    </Badge>
  );
}

export function Alert({
  tone = "info",
  children,
  role,
}: {
  tone?: "error" | "success" | "info" | "warning";
  children: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div className={`alert alert-${tone}`} role={role ?? (tone === "error" ? "alert" : "status")}>
      <span aria-hidden="true">
        {tone === "error" ? "⚠" : tone === "success" ? "✓" : tone === "warning" ? "!" : "i"}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {description ? <p className="small">{description}</p> : null}
      {action ? <div className="mt-16">{action}</div> : null}
    </div>
  );
}

export function LoadingBlock({ rows = 3, label = "Memuat data…" }: { rows?: number; label?: string }) {
  return (
    <div className="stack gap-12" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" />
      ))}
    </div>
  );
}

const ICON_PATHS = {
  dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  exams: "M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3 M8 2h8v4H8z M7 11h10 M7 15h7",
  monitor: "M3 4h18v13H3z M8 21h8 M12 17v4 M6 11h3l2-4 3 7 2-3h2",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  audit: "M14 2H6v20h14V8z M14 2v6h6 M9 12h8 M9 16h6",
  timer: "M9 2h6 M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M12 10v4l3 2",
  logout: "M9 3H4v18h5 M15 8l5 4-5 4 M20 12H9",
  shield: "M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6",
  online: "M2 8a16 16 0 0 1 20 0 M5 12a11 11 0 0 1 14 0 M9 16a5 5 0 0 1 6 0 M12 20h.01",
  offline: "M2 2l20 20 M2 8a16 16 0 0 1 3-2 M9 5a16 16 0 0 1 13 3 M5 12a11 11 0 0 1 4-2 M14 10a11 11 0 0 1 5 2 M9 16a5 5 0 0 1 6 0 M12 20h.01",
  warning: "M12 3L2 21h20z M12 9v5 M12 18h.01",
  check: "M20 6L9 17l-5-5",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5",
  arrow: "M5 12h14 M14 7l5 5-5 5",
  close: "M6 6l12 12 M18 6L6 18",
} as const;

export function Icon({ name, className = "nav-icon" }: { name: keyof typeof ICON_PATHS; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function Stat({ label, value, hint, icon = "dashboard", tone = "neutral" }: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: keyof typeof ICON_PATHS;
  tone?: "neutral" | "online" | "danger" | "warning";
}) {
  return (
    <div className="stat" data-tone={tone}>
      <div className="stat-top">
        <div className="stat-label">{label}</div>
        <span className="stat-icon"><Icon name={icon} /></span>
      </div>
      <div className="stat-value mono">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

/**
 * Every timestamp in the UI is rendered in Asia/Jakarta (WIB, UTC+7) regardless
 * of the viewer's own timezone. Proctors and participants are all in Indonesia,
 * and mixing browser-local time with the WIB exports caused confusion.
 */
export const APP_TIME_ZONE = "Asia/Jakarta";
export const APP_TIME_ZONE_LABEL = "WIB";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("id-ID", {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Same instant, but with an explicit "WIB" suffix for places where ambiguity matters. */
export function formatDateTimeWib(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${formatDateTime(value)} ${APP_TIME_ZONE_LABEL}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("id-ID", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Compact "baru saja / 12 dtk lalu / 3 mnt lalu" label for live data. */
export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 5) return "baru saja";
  if (seconds < 60) return `${seconds} dtk lalu`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return formatDateTime(value);
}
