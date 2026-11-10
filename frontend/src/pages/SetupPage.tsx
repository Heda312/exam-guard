import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api";
import { Alert } from "../ui";

export default function SetupPage() {
  const navigate = useNavigate();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [secretConfigured, setSecretConfigured] = useState(true);
  const [form, setForm] = useState({
    setup_secret: "",
    email: "",
    full_name: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .setupStatus()
      .then((status) => {
        setSetupRequired(status.setup_required);
        setSecretConfigured(status.setup_secret_configured);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError("Konfirmasi kata sandi tidak cocok.");
      return;
    }
    setSubmitting(true);
    try {
      await api.setup({
        setup_secret: form.setup_secret,
        email: form.email.trim(),
        full_name: form.full_name.trim(),
        password: form.password,
      });
      navigate("/login", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (setupRequired === false) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Setup sudah selesai</h1>
          <p className="subtitle">
            Akun administrator awal sudah dibuat. Halaman setup dinonaktifkan secara permanen.
          </p>
          <Alert tone="info">
            Jika Anda kehilangan akses administrator, ikuti prosedur pemulihan berbasis server pada
            dokumentasi (<code>docs/RECOVERY.md</code>).
          </Alert>
          <button type="button" className="btn btn-primary btn-block" onClick={() => navigate("/login")}>
            Ke halaman masuk
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Setup awal ExamGuard</h1>
        <p className="subtitle">
          Buat akun administrator pertama. Setup memerlukan setup secret yang hanya tersedia di
          environment server.
        </p>

        {!secretConfigured ? (
          <Alert tone="error">
            <code>SETUP_SECRET</code> belum diatur pada server. Setup tidak dapat dilanjutkan.
          </Alert>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="setup_secret">Setup secret</label>
            <input
              id="setup_secret"
              type="password"
              value={form.setup_secret}
              onChange={(event) => update("setup_secret", event.target.value)}
              required
              autoComplete="off"
            />
            <span className="hint">Nilai variabel <code>SETUP_SECRET</code> pada server.</span>
          </div>
          <div className="field">
            <label htmlFor="full_name">Nama lengkap administrator</label>
            <input
              id="full_name"
              type="text"
              value={form.full_name}
              onChange={(event) => update("full_name", event.target.value)}
              required
              autoComplete="name"
            />
          </div>
          <div className="field">
            <label htmlFor="email">Email administrator</label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="password">Kata sandi</label>
              <input
                id="password"
                type="password"
                value={form.password}
                onChange={(event) => update("password", event.target.value)}
                required
                minLength={10}
                autoComplete="new-password"
              />
              <span className="hint">Minimal 10 karakter, memuat huruf dan angka.</span>
            </div>
            <div className="field">
              <label htmlFor="confirm">Konfirmasi kata sandi</label>
              <input
                id="confirm"
                type="password"
                value={form.confirm}
                onChange={(event) => update("confirm", event.target.value)}
                required
                autoComplete="new-password"
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={submitting || !secretConfigured}
          >
            {submitting ? "Membuat akun…" : "Buat akun administrator"}
          </button>
        </form>
      </div>
    </div>
  );
}
