import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";
import { api, errorMessage } from "./api";
import { Alert, Icon } from "./ui";

export default function AppShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
      { to: "/", label: "Ringkasan", icon: "dashboard", show: true } as const,
      { to: "/exams", label: "Ujian", icon: "exams", show: true } as const,
      { to: "/monitoring", label: "Pemantauan", icon: "monitor", show: true } as const,
      { to: "/proctors", label: "Proktor", icon: "users", show: isAdmin } as const,
      { to: "/audit", label: "Audit Log", icon: "audit", show: isAdmin } as const,
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
            <Icon name="shield" />
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
                <Icon name={link.icon} />
                {link.label}
              </NavLink>
            ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="user-avatar" aria-hidden="true">{(me?.user.full_name || me?.user.username || "EG").slice(0, 2).toUpperCase()}</div>
            <div className="user-details">
              <strong>{me?.user.full_name || me?.user.username}</strong>
              <span>{isAdmin ? "Administrator" : "Proktor"}</span>
            </div>
          </div>
          <div className="mt-16">
            <button type="button" className="btn btn-ghost btn-sm btn-block" onClick={handleLogout}>
              <Icon name="logout" />
              Keluar
            </button>
          </div>
        </div>
      </aside>

      <main className="main" id="main-content">
        <div className="app-topbar">
          <span className="small muted">Workspace <span aria-hidden="true">/</span> <strong>{links.find((link) => link.to === "/" ? location.pathname === "/" : location.pathname.startsWith(link.to))?.label ?? "ExamGuard"}</strong></span>
          <span className="topbar-status"><Icon name="shield" /> Pemantauan berbasis extension <span className="badge badge-neutral">WIB · UTC+7</span></span>
        </div>
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
