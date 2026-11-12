import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { Exam, Proctor } from "../types";
import { Alert, EmptyState, LoadingBlock, ExamStatusBadge, formatDateTime } from "../ui";

const DEFAULT_PERMISSIONS = {
  can_view_exam: true,
  can_view_participants: true,
  can_start_exam: false,
  can_end_exam: false,
  can_review_incidents: true,
  can_export_report: false,
};

const PERMISSION_LABELS: Record<string, string> = {
  can_view_exam: "Melihat ujian",
  can_view_participants: "Melihat peserta",
  can_start_exam: "Memulai ujian",
  can_end_exam: "Mengakhiri ujian",
  can_review_incidents: "Meninjau insiden",
  can_export_report: "Mengekspor laporan",
};

export default function ProctorsPage() {
  const [proctors, setProctors] = useState<Proctor[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ full_name: "", username: "", password: "" });
  const [permissions, setPermissions] = useState({ ...DEFAULT_PERMISSIONS });
  // Assigning right away avoids the "proctor exists but sees nothing" trap: an
  // account with no exam assignment cannot open any exam, so it looks offline.
  const [assignTo, setAssignTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [proctorList, examList] = await Promise.all([api.listProctors(), api.listExams()]);
      setProctors(proctorList);
      setExams(examList);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const proctor = await api.createProctor({
        full_name: form.full_name.trim(),
        username: form.username.trim(),
        password: form.password,
        permissions,
      });

      // Assign the selected exams immediately. An unassigned proctor can log in
      // but sees no exams at all, which reads as "not connected to the server".
      const assigned: string[] = [];
      for (const examId of assignTo) {
        try {
          await api.assignProctor(examId, {
            proctor_user_id: proctor.id,
            permissions: { ...permissions },
          });
          assigned.push(examId);
        } catch (err) {
          setError(errorMessage(err));
        }
      }

      setForm({ full_name: "", username: "", password: "" });
      setPermissions({ ...DEFAULT_PERMISSIONS });
      setAssignTo([]);
      setNotice(
        assigned.length > 0
          ? `Akun proktor dibuat dan ditugaskan ke ${assigned.length} ujian. Berikan username dan kata sandi kepada proktor.`
          : "Akun proktor dibuat, tetapi belum ditugaskan ke ujian mana pun. " +
            "Tanpa penugasan, proktor tidak akan melihat ujian apa pun.",
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function assignExam(proctor: Proctor, examId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.assignProctor(examId, {
        proctor_user_id: proctor.id,
        permissions: { ...DEFAULT_PERMISSIONS },
      });
      setNotice("Proktor ditugaskan ke ujian.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(proctor: Proctor) {
    setBusy(true);
    try {
      await api.updateProctor(proctor.id, { is_active: !proctor.is_active });
      setNotice(proctor.is_active ? "Akun proktor dinonaktifkan." : "Akun proktor diaktifkan kembali.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(proctor: Proctor) {
    const password = window.prompt(`Kata sandi baru untuk ${proctor.username}:`);
    if (!password) return;
    setBusy(true);
    try {
      await api.updateProctor(proctor.id, { password });
      setNotice("Kata sandi proktor direset.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(proctor: Proctor) {
    const confirmed = window.confirm(
      `Hapus akun proktor "${proctor.full_name}" (${proctor.username})? ` +
        "Semua penugasan ujiannya juga akan dihapus. Tindakan ini tidak dapat dibatalkan.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProctor(proctor.id);
      setNotice(`Akun proktor ${proctor.username} dihapus.`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Manajemen akses</div>
          <h1>Proktor</h1>
          <p>
            Proktor masuk dengan username dan kata sandi. Proktor hanya dapat mengakses ujian yang
            ditugaskan kepadanya; izin tambahan diatur per ujian pada halaman detail ujian.
          </p>
        </div>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <h2>Buat akun proktor</h2>
            <p>Izin di bawah adalah default saat proktor ditugaskan ke ujian.</p>
          </div>
        </div>
        <form onSubmit={create}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="proctor_name">Nama lengkap</label>
              <input
                id="proctor_name"
                type="text"
                value={form.full_name}
                onChange={(event) => setForm({ ...form, full_name: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="proctor_username">Username</label>
              <input
                id="proctor_username"
                type="text"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                autoComplete="off"
                minLength={3}
                required
              />
              <span className="hint">Dipakai untuk masuk. Tanpa spasi, minimal 3 karakter.</span>
            </div>
            <div className="field">
              <label htmlFor="proctor_password">Kata sandi</label>
              <input
                id="proctor_password"
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                minLength={10}
                required
              />
              <span className="hint">Minimal 10 karakter, huruf dan angka.</span>
            </div>
          </div>
          <fieldset style={{ border: "none", padding: 0, margin: "0 0 16px" }}>
            <legend className="small muted" style={{ marginBottom: 8 }}>
              Tugaskan ke ujian (disarankan)
            </legend>
            {exams.length === 0 ? (
              <p className="small muted">
                Belum ada ujian. Buat ujian terlebih dahulu, lalu tugaskan proktor.
              </p>
            ) : (
              <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
                {exams.map((exam) => (
                  <label key={exam.id} className="row small" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={assignTo.includes(exam.id)}
                      onChange={(event) =>
                        setAssignTo((current) =>
                          event.target.checked
                            ? [...current, exam.id]
                            : current.filter((id) => id !== exam.id),
                        )
                      }
                    />
                    <span className="mono">{exam.exam_code}</span>
                    <span>{exam.name}</span>
                    <ExamStatusBadge status={exam.status} />
                  </label>
                ))}
              </div>
            )}
            <p className="small muted" style={{ marginTop: 8 }}>
              Tanpa penugasan, proktor bisa masuk tetapi tidak melihat ujian apa pun — tampak
              seperti tidak terhubung ke server.
            </p>
          </fieldset>
          <fieldset style={{ border: "none", padding: 0, margin: "0 0 16px" }}>
            <legend className="small muted" style={{ marginBottom: 8 }}>
              Izin default
            </legend>
            <div className="row">
              {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
                <label key={key} className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(permissions[key as keyof typeof permissions])}
                    onChange={(event) =>
                      setPermissions((current) => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Menyimpan…" : "Buat akun proktor"}
          </button>
        </form>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Daftar proktor</h2>
            <p>{proctors.length} akun proktor.</p>
          </div>
        </div>
        {loading ? (
          <LoadingBlock rows={3} />
        ) : proctors.length === 0 ? (
          <EmptyState title="Belum ada proktor" description="Buat akun proktor untuk membantu pengawasan." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Username</th>
                  <th>Status</th>
                  <th>Ujian</th>
                  <th>Terakhir masuk</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {proctors.map((proctor) => (
                  <tr key={proctor.id}>
                    <td>{proctor.full_name}</td>
                    <td className="mono">{proctor.username}</td>
                    <td>
                      <span className={`badge ${proctor.is_active ? "badge-success" : "badge-neutral"}`}>
                        {proctor.is_active ? "Aktif" : "Nonaktif"}
                      </span>
                    </td>
                    <td>
                      {proctor.assigned_exam_count > 0 ? (
                        <span className="mono">{proctor.assigned_exam_count}</span>
                      ) : (
                        <span className="badge badge-warning" title="Tanpa penugasan, proktor tidak melihat ujian apa pun">
                          Belum ditugaskan
                        </span>
                      )}
                    </td>
                    <td className="small muted">{formatDateTime(proctor.last_login_at)}</td>
                    <td className="text-right">
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {proctor.assigned_exam_count === 0 && exams.length > 0 ? (
                          <select
                            className="btn btn-sm"
                            defaultValue=""
                            onChange={(event) => {
                              if (event.target.value) void assignExam(proctor, event.target.value);
                            }}
                            disabled={busy}
                            aria-label={`Tugaskan ${proctor.username} ke ujian`}
                          >
                            <option value="">Tugaskan ke…</option>
                            {exams.map((exam) => (
                              <option key={exam.id} value={exam.id}>
                                {exam.exam_code} · {exam.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => resetPassword(proctor)}
                          disabled={busy}
                        >
                          Reset sandi
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => toggleActive(proctor)}
                          disabled={busy}
                        >
                          {proctor.is_active ? "Nonaktifkan" : "Aktifkan"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => remove(proctor)}
                          disabled={busy}
                        >
                          Hapus
                        </button>
                      </div>
                    </td>
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
