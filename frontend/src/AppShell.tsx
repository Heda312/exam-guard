import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";
import { api, errorMessage } from "./api";
import { Alert } from "./ui";

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    dashboard: "M3 12h7V3H3v9Zm0 9h7v-7H3v7Zm11 0h7V12h-7v9Zm0-18v7h7V3h-7Z",
    exams: "M4 4h16v4H4V4Zm0 6h16v10H4V10Zm3 3h5v2H7v-2Z",
    monitor: "M3 4h18v12H3V4Zm2 14h14v2H5v-2Zm7-11-4 5h3v3l4-5h-3V7Z",
    roster: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2-7 4v3h14v-3c0-2-3-4-7-4Zm9-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-1 0-2 .2-3 .5 1.2 1 2 2.2 2 3.5v3h5v-3c0-2-2-4-4-4Z",
    users: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8v-2c0-2.2 3.6-4 8-4s8 1.8 8 4v2H4Z",
    audit: "M6 2h9l5 5v15H6V2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z",
    timer: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 10.6V6h-2v7.4l5 3 1-1.7-4-2.1Z",
    logout: "M10 3H4v18h6v-2H6V5h4V3Zm5 4-1.4 1.4L16.2 11H9v2h7.2l-2.6 2.6L15 17l5-5-5-5Z",
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={paths[name] ?? paths.dashboard} />
    </svg>
  );
}

export default function AppShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [setupRequired, setSetupRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .setupStatus()
      .then((status) => setSetupRequired(status.setup_required))
      .catch(() => setSetupRequired(false));
  }, []);

  const isAdmin = me?.permissions.is_admin ?? false;

  const links = useMemo(
    () => [
      { to: "/", label: "Ringkasan", icon: "dashboard", show: true },
      { to: "/exams", label: "Ujian", icon: "exams", show: true },
      { to: "/monitoring", label: "Pemantauan", icon: "monitor", show: true },
      { to: "/proctors", label: "Proktor", icon: "users", show: isAdmin },
      { to: "/audit", label: "Audit Log", icon: "audit", show: isAdmin },
    ],
    [isAdmin],
  );

  async function handleLogout() {
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            EG
          </div>
          <div className="brand-text">
            <strong>ExamGuard</strong>
            <span>Exam Monitoring</span>
          </div>
        </div>

        <nav className="nav-group" aria-label="Navigasi utama">
          <div className="nav-label">Operasional</div>
          {links
            .filter((link) => link.show)
            .map((link) => (
              <NavLink key={link.to} to={link.to} end={link.to === "/"} className="nav-link">
                <NavIcon name={link.icon} />
                {link.label}
              </NavLink>
            ))}
        </nav>

        <div className="sidebar-footer">
          <strong>{me?.user.full_name || me?.user.email}</strong>
          <span>{isAdmin ? "Administrator" : "Proktor"}</span>
          <div className="mt-16">
            <button type="button" className="btn btn-ghost btn-sm btn-block" onClick={handleLogout}>
              <NavIcon name="logout" />
              Keluar
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {setupRequired ? (
          <Alert tone="warning">
            Setup awal belum diselesaikan.{" "}
            <a href="/setup">Buka halaman setup</a> menggunakan setup secret dari server.
          </Alert>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Outlet />
      </main>
    </div>
  );
}
