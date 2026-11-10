import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam, ExamProctorAssignment, Proctor, RosterEntry, RosterImportPreview } from "../types";
import {
  Alert,
  EmptyState,
  ExamStatusBadge,
  LoadingBlock,
  formatDateTime,
  participantStatusLabel,
} from "../ui";

type Tab = "roster" | "proctors" | "settings";

export default function ExamDetailPage() {
  const { examId = "" } = useParams();
  const { me, canManageExam } = useAuth();
  const [exam, setExam] = useState<Exam | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [assignments, setAssignments] = useState<ExamProctorAssignment[]>([]);
  const [proctors, setProctors] = useState<Proctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("roster");
  const [search, setSearch] = useState("");

  const isAdmin = me?.permissions.is_admin ?? false;
  const canStart = canManageExam(examId, "can_start_exam");
  const canEnd = canManageExam(examId, "can_end_exam");
  const canExport = canManageExam(examId, "can_export_report");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await api.getExam(examId);
      setExam(detail);
      if (canManageExam(examId, "can_view_participants")) {
        setRoster(await api.listRoster(examId));
      }
      if (isAdmin) {
        setAssignments(await api.listExamProctors(examId));
        setProctors(await api.listProctors());
      }
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [examId, canManageExam, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleStart() {
    setError(null);
    setNotice(null);
    try {
      const updated = await api.startExam(examId);
      setExam(updated);
      setNotice("Ujian dimulai. Timer server sekarang berjalan dan tidak berhenti saat peserta terputus.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleEnd() {
    if (!window.confirm("Akhiri ujian sekarang? Seluruh sesi peserta akan ditutup.")) return;
    setError(null);
    setNotice(null);
    try {
      const updated = await api.endExam(examId);
      setExam(updated);
      setNotice("Ujian telah diakhiri.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (loading) return <LoadingBlock rows={4} />;
  if (!exam) return <Alert tone="error">{error ?? "Ujian tidak ditemukan."}</Alert>;

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Detail ujian · {exam.exam_code}</div>
          <h1>{exam.name}</h1>
          <p>
            {exam.description || "Tidak ada deskripsi."} · Durasi {exam.duration_minutes} menit
          </p>
          <div className="row mt-16">
            <ExamStatusBadge status={exam.status} />
            <span className="small muted">Peserta: {exam.participant_count}</span>
            <span className="small muted">Insiden: {exam.incident_count}</span>
            <span className="small muted">Berakhir: {formatDateTime(exam.ends_at)}</span>
          </div>
        </div>
        <div className="row">
          {canStart && exam.status !== "LIVE" && exam.status !== "COMPLETED" ? (
            <button type="button" className="btn btn-primary" onClick={handleStart}>
              Mulai ujian
            </button>
          ) : null}
          {canEnd && exam.status === "LIVE" ? (
            <button type="button" className="btn btn-danger" onClick={handleEnd}>
              Akhiri ujian
            </button>
          ) : null}
          {exam.status === "LIVE" ? (
            <Link to={`/monitoring/${exam.id}`} className="btn btn-secondary">
              Buka pemantauan
            </Link>
          ) : null}
          {canExport ? (
            <>
              <a className="btn btn-ghost" href={api.reportUrl(exam.id, "csv")}>
                Ekspor CSV
              </a>
              <a className="btn btn-ghost" href={api.reportUrl(exam.id, "xlsx")}>
                Ekspor XLSX
              </a>
            </>
          ) : null}
        </div>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="row" role="tablist" aria-label="Bagian ujian" style={{ marginBottom: 18 }}>
        {(
          [
            ["roster", "Roster peserta"],
            ...(isAdmin ? [["proctors", "Proktor & izin"]] : []),
            ...(isAdmin ? [["settings", "Pengaturan"]] : []),
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`btn ${tab === value ? "btn-primary" : "btn-ghost"} btn-sm`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "roster" ? (
        <RosterPanel
          exam={exam}
          roster={roster}
          search={search}
          setSearch={setSearch}
          isAdmin={isAdmin}
          onChanged={load}
          setError={setError}
          setNotice={setNotice}
        />
      ) : null}

      {tab === "proctors" && isAdmin ? (
        <ProctorPanel
          exam={exam}
          assignments={assignments}
          proctors={proctors}
          onChanged={load}
          setError={setError}
          setNotice={setNotice}
        />
      ) : null}

      {tab === "settings" && isAdmin ? (
        <SettingsPanel exam={exam} onChanged={load} setError={setError} setNotice={setNotice} />
      ) : null}
    </div>
  );
}

/* ------------------------------ Roster ------------------------------ */
function RosterPanel({
  exam,
  roster,
  search,
  setSearch,
  isAdmin,
  onChanged,
  setError,
  setNotice,
}: {
  exam: Exam;
  roster: RosterEntry[];
  search: string;
  setSearch: (value: string) => void;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [npm, setNpm] = useState("");
  const [group, setGroup] = useState("");
  const [preview, setPreview] = useState<RosterImportPreview | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const rosterLocked = ["LIVE", "COMPLETED", "CANCELLED"].includes(exam.status);
  const filtered = roster.filter((entry) => {
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return (
      entry.full_name.toLowerCase().includes(needle) || (entry.npm ?? "").toLowerCase().includes(needle)
    );
  });

  async function addParticipant(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addRosterEntry(exam.id, {
        full_name: name.trim(),
        npm: npm.trim() || null,
        group_name: group.trim() || null,
      });
      setName("");
      setNpm("");
      setGroup("");
      setNotice("Peserta ditambahkan ke roster.");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(entry: RosterEntry) {
    if (!window.confirm(`Hapus ${entry.full_name} dari roster?`)) return;
    setBusy(true);
    try {
      await api.deleteRosterEntry(exam.id, entry.id);
      setNotice("Peserta dihapus dari roster.");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview(file: File) {
    setBusy(true);
    setError(null);
    try {
      setPendingFile(file);
      setPreview(await api.previewImport(exam.id, file));
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
      setPendingFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!pendingFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.commitImport(exam.id, pendingFile);
      setNotice(`Impor selesai: ${result.imported} peserta ditambahkan, ${result.skipped} dilewati.`);
      setPreview(null);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleErrorReport() {
    if (!preview) return;
    setBusy(true);
    try {
      const blob = await api.downloadImportErrorReport(
        exam.id,
        preview.rows.filter((row) => row.status !== "ok" || row.message),
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `roster-import-errors-${exam.exam_code}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Roster peserta</h2>
          <p>
            Identitas peserta divalidasi melalui Exam ID + nama yang dinormalisasi. NPM bersifat
            informasional dan tidak dipakai untuk validasi.
          </p>
        </div>
        <input
          type="search"
          placeholder="Cari nama atau NPM…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Cari peserta"
          style={{ maxWidth: 240 }}
        />
      </div>

      {isAdmin && !rosterLocked ? (
        <div className="stack gap-16" style={{ marginBottom: 22 }}>
          <form onSubmit={addParticipant} className="form-row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="participant_name">Nama lengkap</label>
              <input
                id="participant_name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="participant_npm">NPM (opsional)</label>
              <input id="participant_npm" type="text" value={npm} onChange={(event) => setNpm(event.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="participant_group">Kelompok (opsional)</label>
              <input
                id="participant_group"
                type="text"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-secondary" disabled={busy || !name.trim()}>
              Tambah peserta
            </button>
          </form>

          <div className="alert alert-info" style={{ marginBottom: 0 }}>
            <div>
              <strong>Impor CSV.</strong> Kolom wajib: <code>full_name</code>. Kolom opsional:{" "}
              <code>npm</code>, <code>email</code>, <code>group_name</code>. Duplikat nama
              (setelah normalisasi) otomatis ditolak.
              <div className="row mt-16">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handlePreview(file);
                  }}
                  aria-label="Berkas CSV roster"
                />
                <a className="btn btn-ghost btn-sm" href={api.importTemplateUrl(exam.id)}>
                  Unduh template
                </a>
              </div>
            </div>
          </div>

          {preview ? (
            <div className="card" style={{ background: "rgba(220,231,217,0.3)" }}>
              <div className="row-between">
                <div>
                  <strong>Pratinjau impor</strong>
                  <div className="small muted">
                    {preview.total_rows} baris · {preview.valid_rows} valid · {preview.error_rows} error ·{" "}
                    {preview.warning_rows} peringatan
                  </div>
                </div>
                <div className="row">
                  <button type="button" className="btn btn-primary btn-sm" onClick={handleCommit} disabled={busy}>
                    Impor {preview.valid_rows} baris valid
                  </button>
                  {preview.error_rows > 0 || preview.warning_rows > 0 ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleErrorReport}>
                      Unduh laporan error
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setPreview(null);
                      setPendingFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                  >
                    Batal
                  </button>
                </div>
              </div>
              <div className="table-wrap mt-16" style={{ maxHeight: 320, overflowY: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Baris</th>
                      <th>Nama</th>
                      <th>NPM</th>
                      <th>Status</th>
                      <th>Catatan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.row_number}>
                        <td className="mono">{row.row_number}</td>
                        <td>{row.full_name || "—"}</td>
                        <td className="mono">{row.npm || "—"}</td>
                        <td>
                          <span
                            className={`badge ${
                              row.status === "ok"
                                ? "badge-success"
                                : row.status === "invalid"
                                  ? "badge-danger"
                                  : "badge-warning"
                            }`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td className="small muted">{row.message || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {rosterLocked ? (
        <Alert tone="info">Roster tidak dapat diubah setelah ujian dimulai atau selesai.</Alert>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          title="Roster masih kosong"
          description="Tambahkan peserta secara manual atau impor dari CSV."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nama (kanonis)</th>
                <th>Kunci normalisasi</th>
                <th>NPM</th>
                <th>Kelompok</th>
                <th>Status sesi</th>
                {isAdmin && !rosterLocked ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.full_name}</td>
                  <td className="mono small muted">{entry.normalized_name}</td>
                  <td className="mono">{entry.npm || "—"}</td>
                  <td>{entry.group_name || "—"}</td>
                  <td>
                    {entry.participant_session_status ? (
                      <span className="badge badge-neutral">
                        {participantStatusLabel(entry.participant_session_status)}
                      </span>
                    ) : (
                      <span className="small muted">Belum mendaftar</span>
                    )}
                  </td>
                  {isAdmin && !rosterLocked ? (
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeEntry(entry)}
                        disabled={busy}
                      >
                        Hapus
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ Proctors ----------------------------- */
const PERMISSION_LABELS: Record<string, string> = {
  can_view_exam: "Melihat ujian",
  can_view_participants: "Melihat peserta",
  can_start_exam: "Memulai ujian",
  can_end_exam: "Mengakhiri ujian",
  can_review_incidents: "Meninjau insiden",
  can_export_report: "Mengekspor laporan",
};

function ProctorPanel({
  exam,
  assignments,
  proctors,
  onChanged,
  setError,
  setNotice,
}: {
  exam: Exam;
  assignments: ExamProctorAssignment[];
  proctors: Proctor[];
  onChanged: () => Promise<void>;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  const [selected, setSelected] = useState("");
  const [permissions, setPermissions] = useState<Record<string, boolean>>({
    can_view_exam: true,
    can_view_participants: true,
    can_start_exam: false,
    can_end_exam: false,
    can_review_incidents: true,
    can_export_report: false,
  });
  const [busy, setBusy] = useState(false);

  const available = proctors.filter(
    (proctor) =>
      proctor.is_active && !assignments.some((item) => item.proctor_user_id === proctor.id),
  );

  async function assign(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.assignProctor(exam.id, { proctor_user_id: selected, permissions });
      setSelected("");
      setNotice("Proktor ditugaskan pada ujian ini.");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function updatePermission(assignment: ExamProctorAssignment, key: string, value: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.updateAssignment(exam.id, assignment.id, {
        ...assignment.permissions,
        [key]: value,
      });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(assignment: ExamProctorAssignment) {
    if (!window.confirm(`Hapus penugasan ${assignment.proctor_full_name}?`)) return;
    setBusy(true);
    try {
      await api.removeAssignment(exam.id, assignment.id);
      setNotice("Penugasan proktor dihapus.");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Proktor & izin</h2>
          <p>Izin ditegakkan di server pada setiap permintaan yang melibatkan ujian ini.</p>
        </div>
      </div>

      <form onSubmit={assign} className="stack gap-12" style={{ marginBottom: 22 }}>
        <div className="form-row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="proctor_select">Pilih proktor</label>
            <select
              id="proctor_select"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">— Pilih proktor —</option>
              {available.map((proctor) => (
                <option key={proctor.id} value={proctor.id}>
                  {proctor.full_name} ({proctor.email})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-secondary" disabled={busy || !selected}>
            Tugaskan
          </button>
        </div>
        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>
            Izin awal
          </legend>
          <div className="row">
            {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
              <label key={key} className="row small" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={Boolean(permissions[key])}
                  onChange={(event) =>
                    setPermissions((current) => ({ ...current, [key]: event.target.checked }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </form>

      {assignments.length === 0 ? (
        <EmptyState title="Belum ada proktor" description="Tugaskan proktor agar dapat memantau ujian ini." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Proktor</th>
                {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <td>
                    <div>{assignment.proctor_full_name}</div>
                    <div className="small muted">{assignment.proctor_email}</div>
                  </td>
                  {Object.keys(PERMISSION_LABELS).map((key) => (
                    <td key={key}>
                      <input
                        type="checkbox"
                        aria-label={`${PERMISSION_LABELS[key]} untuk ${assignment.proctor_full_name}`}
                        checked={Boolean(
                          (assignment.permissions as unknown as Record<string, boolean>)[key],
                        )}
                        disabled={busy}
                        onChange={(event) => updatePermission(assignment, key, event.target.checked)}
                      />
                    </td>
                  ))}
                  <td className="text-right">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(assignment)}>
                      Hapus
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------ Settings ----------------------------- */
function SettingsPanel({
  exam,
  onChanged,
  setError,
  setNotice,
}: {
  exam: Exam;
  onChanged: () => Promise<void>;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}) {
  const [form, setForm] = useState({
    name: exam.name,
    description: exam.description ?? "",
    google_forms_url: exam.google_forms_url ?? "",
    duration_minutes: exam.duration_minutes,
    status: exam.status,
  });
  const [busy, setBusy] = useState(false);
  const [urlCheck, setUrlCheck] = useState<string | null>(null);

  const locked = ["LIVE", "COMPLETED", "CANCELLED"].includes(exam.status);

  async function testUrl() {
    if (!form.google_forms_url.trim()) return;
    setBusy(true);
    setUrlCheck(null);
    try {
      const result = await api.validateFormUrl(exam.id, form.google_forms_url.trim());
      setUrlCheck(`URL valid · host ${result.host}`);
    } catch (err) {
      setUrlCheck(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateExam(exam.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        google_forms_url: form.google_forms_url.trim() || null,
        duration_minutes: Number(form.duration_minutes),
      });
      if (form.status !== exam.status) {
        await api.changeExamStatus(exam.id, form.status);
      }
      setNotice("Pengaturan ujian diperbarui.");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Pengaturan ujian</h2>
          <p>Durasi dan URL formulir tidak dapat diubah setelah ujian dimulai.</p>
        </div>
      </div>
      <form onSubmit={save}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="settings_name">Nama ujian</label>
            <input
              id="settings_name"
              type="text"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="settings_status">Status</label>
            <select
              id="settings_status"
              value={form.status}
              onChange={(event) => setForm({ ...form, status: event.target.value as Exam["status"] })}
              disabled={locked}
            >
              <option value="DRAFT">Draf</option>
              <option value="SCHEDULED">Terjadwal</option>
              <option value="REGISTRATION_OPEN">Pendaftaran dibuka</option>
              <option value="WAITING">Menunggu</option>
              <option value="COMPLETED">Selesai</option>
              <option value="CANCELLED">Dibatalkan</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="settings_duration">Durasi (menit)</label>
            <input
              id="settings_duration"
              type="number"
              min={1}
              max={600}
              value={form.duration_minutes}
              onChange={(event) => setForm({ ...form, duration_minutes: Number(event.target.value) })}
              disabled={locked}
            />
          </div>
          <div className="field">
            <label htmlFor="settings_forms">URL formulir</label>
            <input
              id="settings_forms"
              type="url"
              value={form.google_forms_url}
              onChange={(event) => {
                setForm({ ...form, google_forms_url: event.target.value });
                setUrlCheck(null);
              }}
              disabled={locked}
            />
            {!locked ? (
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={testUrl}
                  disabled={busy || !form.google_forms_url.trim()}
                >
                  Uji URL
                </button>
                {urlCheck ? <span className="small muted">{urlCheck}</span> : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="field">
          <label htmlFor="settings_description">Deskripsi</label>
          <textarea
            id="settings_description"
            rows={3}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan perubahan"}
        </button>
      </form>
    </section>
  );
}
