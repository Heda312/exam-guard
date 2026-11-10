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
  "exam.created": "Ujian dibuat",
  "exam.updated": "Ujian diperbarui",
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
    return (
      log.action.toLowerCase().includes(needle) ||
      (log.actor_label ?? "").toLowerCase().includes(needle) ||
      (log.resource_type ?? "").toLowerCase().includes(needle)
    );
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
          placeholder="Cari aksi, aktor, atau resource…"
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
                    <td className="small mono muted">
                      {log.resource_type ? `${log.resource_type}` : "—"}
                      {log.resource_id ? ` · ${log.resource_id.slice(0, 8)}` : ""}
                    </td>
                    <td className="small mono muted" style={{ maxWidth: 260, wordBreak: "break-word" }}>
                      {Object.keys(log.metadata_json ?? {}).length > 0
                        ? JSON.stringify(log.metadata_json)
                        : "—"}
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
