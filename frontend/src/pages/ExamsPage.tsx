import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam } from "../types";
import { Alert, EmptyState, ExamStatusBadge, LoadingBlock, formatDateTime } from "../ui";

const EMPTY_FORM = {
  name: "",
  exam_code: "",
  description: "",
  google_forms_url: "",
  duration_minutes: 90,
  scheduled_at: "",
  status: "DRAFT",
};

export default function ExamsPage() {
  const { me } = useAuth();
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);

  const isAdmin = me?.permissions.is_admin ?? false;

  async function load() {
    setLoading(true);
    try {
      setExams(await api.listExams());
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

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.createExam({
        name: form.name.trim(),
        exam_code: form.exam_code.trim() || null,
        description: form.description.trim() || null,
        google_forms_url: form.google_forms_url.trim() || null,
        duration_minutes: Number(form.duration_minutes),
        scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
        status: form.status,
      });
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Manajemen ujian</div>
          <h1>Ujian</h1>
          <p>
            Exam ID mengidentifikasi sesi ujian. Exam ID bukan kredensial rahasia — akses peserta
            tetap divalidasi terhadap roster berdasarkan nama yang dinormalisasi.
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowForm((value) => !value)}
            aria-expanded={showForm}
          >
            {showForm ? "Tutup formulir" : "Buat ujian"}
          </button>
        ) : null}
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {showForm && isAdmin ? (
        <section className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <div>
              <h2>Ujian baru</h2>
              <p>Exam ID dapat dikosongkan untuk dibuat otomatis (format EXG-TAHUN-NNN).</p>
            </div>
          </div>
          <form onSubmit={handleCreate} noValidate>
            <div className="form-row">
              <div className="field">
                <label htmlFor="name">Nama ujian</label>
                <input
                  id="name"
                  type="text"
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="exam_code">Exam ID (opsional)</label>
                <input
                  id="exam_code"
                  type="text"
                  value={form.exam_code}
                  onChange={(event) => update("exam_code", event.target.value.toUpperCase())}
                  placeholder="EXG-2026-001"
                  pattern="[A-Za-z0-9][A-Za-z0-9\-_]{2,63}"
                />
                <span className="hint">3–64 karakter: huruf, angka, tanda hubung, garis bawah.</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="google_forms_url">URL formulir ujian (Google Forms)</label>
              <input
                id="google_forms_url"
                type="url"
                value={form.google_forms_url}
                onChange={(event) => update("google_forms_url", event.target.value)}
                placeholder="https://docs.google.com/forms/d/e/…/viewform"
              />
              <span className="hint">Wajib HTTPS dan harus berasal dari domain yang diizinkan.</span>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="duration_minutes">Durasi (menit)</label>
                <input
                  id="duration_minutes"
                  type="number"
                  min={1}
                  max={600}
                  value={form.duration_minutes}
                  onChange={(event) => update("duration_minutes", Number(event.target.value))}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="scheduled_at">Jadwal (opsional)</label>
                <input
                  id="scheduled_at"
                  type="datetime-local"
                  value={form.scheduled_at}
                  onChange={(event) => update("scheduled_at", event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="status">Status awal</label>
                <select
                  id="status"
                  value={form.status}
                  onChange={(event) => update("status", event.target.value)}
                >
                  <option value="DRAFT">Draf</option>
                  <option value="SCHEDULED">Terjadwal</option>
                  <option value="REGISTRATION_OPEN">Pendaftaran dibuka</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="description">Deskripsi (opsional)</label>
              <textarea
                id="description"
                rows={3}
                value={form.description}
                onChange={(event) => update("description", event.target.value)}
              />
            </div>
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Menyimpan…" : "Simpan ujian"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setForm({ ...EMPTY_FORM });
                  setShowForm(false);
                }}
              >
                Batal
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Daftar ujian</h2>
            <p>{exams.length} ujian terlihat oleh akun Anda.</p>
          </div>
        </div>
        {loading ? (
          <LoadingBlock rows={3} />
        ) : exams.length === 0 ? (
          <EmptyState
            title="Belum ada ujian"
            description={
              isAdmin
                ? "Buat ujian pertama, lalu impor roster peserta."
                : "Anda belum ditugaskan pada ujian mana pun."
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Exam ID</th>
                  <th>Nama</th>
                  <th>Status</th>
                  <th>Jadwal</th>
                  <th>Durasi</th>
                  <th>Peserta</th>
                  <th>Insiden</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {exams.map((exam) => (
                  <tr key={exam.id}>
                    <td className="mono">{exam.exam_code}</td>
                    <td>
                      <div>{exam.name}</div>
                      {exam.description ? (
                        <div className="small muted" style={{ maxWidth: 320 }}>
                          {exam.description}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <ExamStatusBadge status={exam.status} />
                    </td>
                    <td className="small muted">{formatDateTime(exam.scheduled_at)}</td>
                    <td className="mono">{exam.duration_minutes} mnt</td>
                    <td className="mono">{exam.participant_count}</td>
                    <td className="mono">{exam.incident_count}</td>
                    <td className="text-right">
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <Link to={`/exams/${exam.id}`} className="btn btn-ghost btn-sm">
                          Detail
                        </Link>
                        {exam.status === "LIVE" ? (
                          <Link to={`/monitoring/${exam.id}`} className="btn btn-secondary btn-sm">
                            Pantau
                          </Link>
                        ) : null}
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
