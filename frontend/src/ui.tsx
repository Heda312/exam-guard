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

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
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
