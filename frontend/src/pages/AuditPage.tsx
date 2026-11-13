import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { AuditLog } from "../types";
import { Alert, EmptyState, LoadingBlock, formatDateTime } from "../ui";

const ACTION_LABELS: Record<string, string> = {
  "setup.completed": "Setup awal diselesaikan",
  "setup.failed": "Percobaan setup gagal",
  "auth.login_success": "Login berhasil",
  "auth.login_failed": "Login gagal",
  "auth.logout": "Logout",
  "auth.password_changed": "Kata sandi diubah",
  "proctor.created": "Proktor dibuat",
  "proctor.updated": "Proktor diperbarui",
  "proctor.deactivated": "Proktor dinonaktifkan",
  "proctor.deleted": "Proktor dihapus",
  "exam.created": "Ujian dibuat",
  "exam.updated": "Ujian diperbarui",
  "exam.deleted": "Ujian dihapus",
  "exam.started": "Ujian dimulai",
  "exam.ended": "Ujian diakhiri",
  "exam.status_changed": "Status ujian diubah",
  "exam.proctor_assigned": "Proktor ditugaskan",
  "exam.proctor_unassigned": "Penugasan dihapus",
  "exam.proctor_permissions_updated": "Izin proktor diperbarui",
  "roster.participant_added": "Peserta ditambahkan",
  "roster.participant_updated": "Peserta diperbarui",
  "roster.participant_removed": "Peserta dihapus",
  "roster.imported": "Roster diimpor",
  "participant.registered": "Peserta mendaftar",
  "participant.registration_failed": "Pendaftaran peserta gagal",
  "incident.reviewed": "Insiden ditinjau",
  "report.exported": "Laporan diekspor",
};

const RESOURCE_LABELS: Record<string, string> = {
  exam: "Ujian",
  user: "Akun",
  participant_session: "Sesi peserta",
  incident: "Insiden",
};

const METADATA_LABELS: Record<string, string> = {
  exam_code: "Kode ujian",
  exam_name: "Nama ujian",
  name: "Nama",
  full_name: "Nama lengkap",
  username: "Username",
  proctor_name: "Proktor",
  proctor_username: "Username proktor",
  participant_name: "Peserta",
  permissions: "Izin",
  changes: "Perubahan",
  reason: "Alasan",
  role: "Peran",
  from: "Dari",
  to: "Ke",
  status: "Status",
  review_status: "Status tinjauan",
  imported: "Diimpor",
  skipped: "Dilewati",
  rows: "Baris",
  format: "Format",
  resumed: "Sesi dilanjutkan",
  password_reset: "Reset sandi",
  is_active: "Aktif",
  exam_session_id: "ID sesi ujian",
  duration_minutes: "Durasi (menit)",
};

const PERMISSION_LABELS: Record<string, string> = {
  can_view_exam: "lihat ujian",
  can_view_participants: "lihat peserta",
  can_start_exam: "mulai ujian",
  can_end_exam: "akhiri ujian",
  can_review_incidents: "tinjau insiden",
  can_export_report: "ekspor laporan",
};

function metadataText(key: string, value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (key === "permissions") {
      const granted = Object.entries(record)
        .filter(([, enabled]) => enabled)
        .map(([name]) => PERMISSION_LABELS[name] ?? name);
      return granted.length > 0 ? granted.join(", ") : "tidak ada";
    }
    return Object.entries(record)
      .map(([name, inner]) => `${METADATA_LABELS[name] ?? name}: ${metadataText(name, inner)}`)
      .join("; ");
  }
  if (typeof value === "boolean") return value ? "ya" : "tidak";
  if (value === null || value === undefined) return "—";
  return String(value);
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api
      .auditLogs(200)
      .then(setLogs)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = logs.filter((log) => {
    if (!filter.trim()) return true;
    const needle = filter.trim().toLowerCase();
    const haystack = [
      log.action,
      ACTION_LABELS[log.action] ?? "",
      log.actor_label ?? "",
      log.resource_type ?? "",
      log.resource_id ?? "",
      JSON.stringify(log.metadata_json ?? {}),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Kepatuhan & audit</div>
          <h1>Audit log</h1>
          <p>
            Catatan tindakan administratif dan proktor. Audit log tidak dapat diubah dari antarmuka.
          </p>
        </div>
        <input
          type="search"
          placeholder="Cari aksi, aktor, nama, atau ID…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Cari audit log"
          style={{ maxWidth: 280 }}
        />
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="card">
        {loading ? (
          <LoadingBlock rows={4} />
        ) : filtered.length === 0 ? (
          <EmptyState title="Belum ada catatan" description="Aktivitas administratif akan muncul di sini." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Aksi</th>
                  <th>Aktor</th>
                  <th>Resource</th>
                  <th>Metadata</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id}>
                    <td className="mono small">{formatDateTime(log.created_at)}</td>
                    <td>
                      <div>{ACTION_LABELS[log.action] ?? log.action}</div>
                      <div className="small muted mono">{log.action}</div>
                    </td>
                    <td className="small">{log.actor_label ?? "—"}</td>
                    <td className="small">
                      {log.resource_type ? (
                        <>
                          <div>{RESOURCE_LABELS[log.resource_type] ?? log.resource_type}</div>
                          {log.resource_id ? (
                            <div className="mono muted" style={{ wordBreak: "break-all" }}>
                              {log.resource_id}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small" style={{ maxWidth: 300 }}>
                      {Object.keys(log.metadata_json ?? {}).length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div style={{ display: "grid", gap: 2, wordBreak: "break-word" }}>
                          {Object.entries(log.metadata_json ?? {}).map(([key, value]) => (
                            <div key={key}>
                              <span className="muted">{METADATA_LABELS[key] ?? key}: </span>
                              {metadataText(key, value)}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="small mono muted">{log.ip_address ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
