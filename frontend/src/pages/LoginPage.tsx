import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { Alert } from "../ui";

export default function LoginPage() {
  const { login, me } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);

  useEffect(() => {
    if (me) navigate("/", { replace: true });
  }, [me, navigate]);

  useEffect(() => {
    api
      .setupStatus()
      .then((status) => setSetupRequired(status.setup_required))
      .catch(() => setSetupRequired(false));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark" aria-hidden="true">
            EG
          </div>
          <div className="brand-text" style={{ color: "var(--forest-950)" }}>
            <strong style={{ color: "var(--forest-950)" }}>ExamGuard</strong>
            <span style={{ color: "var(--stone-700)" }}>Exam Monitoring</span>
          </div>
        </div>

        <h1>Masuk ke dashboard</h1>
        <p className="subtitle">Akun administrator dan proktor menggunakan halaman ini.</p>

        {setupRequired ? (
          <Alert tone="warning">
            Setup awal belum diselesaikan. <Link to="/setup">Buka halaman setup</Link> terlebih dahulu.
          </Alert>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              aria-invalid={Boolean(error) || undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Kata sandi</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Memproses…" : "Masuk"}
          </button>
        </form>

        <div className="auth-footer">
          Peserta ujian tidak masuk melalui halaman ini.{" "}
          <Link to="/join">Buka halaman pendaftaran peserta</Link>.
        </div>
      </div>
    </div>
  );
}
