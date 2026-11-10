import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { Proctor } from "../types";
import { Alert, EmptyState, LoadingBlock, formatDateTime } from "../ui";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ full_name: "", email: "", password: "" });
  const [permissions, setPermissions] = useState({ ...DEFAULT_PERMISSIONS });
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setProctors(await api.listProctors());
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
      await api.createProctor({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        password: form.password,
        permissions,
      });
      setForm({ full_name: "", email: "", password: "" });
      setPermissions({ ...DEFAULT_PERMISSIONS });
      setNotice("Akun proktor dibuat. Proktor harus mengganti kata sandi saat pertama masuk.");
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
      if (proctor.is_active) {
        await api.deactivateProctor(proctor.id);
        setNotice("Akun proktor dinonaktifkan.");
      } else {
        await api.updateProctor(proctor.id, { is_active: true });
        setNotice("Akun proktor diaktifkan kembali.");
      }
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(proctor: Proctor) {
    const password = window.prompt(`Kata sandi baru untuk ${proctor.email}:`);
    if (!password) return;
    setBusy(true);
    try {
      await api.updateProctor(proctor.id, { password });
      setNotice("Kata sandi proktor direset. Proktor harus menggantinya saat masuk.");
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
            Proktor hanya dapat mengakses ujian yang ditugaskan kepadanya. Izin tambahan diatur per
            ujian pada halaman detail ujian.
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
              <label htmlFor="proctor_email">Email</label>
              <input
                id="proctor_email"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="proctor_password">Kata sandi awal</label>
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
                  <th>Email</th>
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
                    <td className="small muted">{proctor.email}</td>
                    <td>
                      <span className={`badge ${proctor.is_active ? "badge-success" : "badge-neutral"}`}>
                        {proctor.is_active ? "Aktif" : "Nonaktif"}
                      </span>
                    </td>
                    <td className="mono">{proctor.assigned_exam_count}</td>
                    <td className="small muted">{formatDateTime(proctor.last_login_at)}</td>
                    <td className="text-right">
                      <div className="row" style={{ justifyContent: "flex-end" }}>
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
