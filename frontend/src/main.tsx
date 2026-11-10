import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth";
import AppShell from "./AppShell";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import DashboardPage from "./pages/DashboardPage";
import ExamsPage from "./pages/ExamsPage";
import ExamDetailPage from "./pages/ExamDetailPage";
import MonitoringPage from "./pages/MonitoringPage";
import ProctorsPage from "./pages/ProctorsPage";
import AuditPage from "./pages/AuditPage";
import ParticipantPage from "./pages/ParticipantPage";
import { LoadingBlock } from "./ui";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) {
    return (
      <div className="auth-shell">
        <div style={{ width: "100%", maxWidth: 420 }}>
          <LoadingBlock rows={2} label="Memeriksa sesi…" />
        </div>
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  if (!me?.permissions.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/join" element={<ParticipantPage />} />
      <Route path="/join/:examCode" element={<ParticipantPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="exams" element={<ExamsPage />} />
        <Route path="exams/:examId" element={<ExamDetailPage />} />
        <Route path="monitoring" element={<MonitoringPage />} />
        <Route path="monitoring/:examId" element={<MonitoringPage />} />
        <Route
          path="proctors"
          element={
            <RequireAdmin>
              <ProctorsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="audit"
          element={
            <RequireAdmin>
              <AuditPage />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
