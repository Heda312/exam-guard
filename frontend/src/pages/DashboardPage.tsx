import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam, MonitoringState, OverviewStats } from "../types";
import { Alert, EmptyState, ExamStatusBadge, Icon, LoadingBlock, Stat, formatDateTime } from "../ui";

export default function DashboardPage() {
  const { me, canManageExam } = useAuth();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [exams, setExams] = useState<Exam[]>([]);
  const [selected, setSelected] = useState("");
  const [state, setState] = useState<MonitoringState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [liveConnection, setLiveConnection] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.overview(), api.listExams()])
      .then(([overview, examList]) => {
        if (cancelled) return;
        setStats(overview);
        setExams(examList);
      })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const monitorableExams = useMemo(
    () => exams.filter((exam) => canManageExam(exam.id, "can_view_participants")),
    [exams, canManageExam],
  );
  useEffect(() => {
    setSelected((previous) => {
      if (previous && monitorableExams.some((exam) => exam.id === previous)) return previous;
      return monitorableExams.find((exam) => exam.status === "LIVE")?.id ?? monitorableExams[0]?.id ?? "";
    });
  }, [monitorableExams]);

  const currentExam = exams.find((exam) => exam.id === selected);
  const examSessionId = currentExam?.exam_session_id;

  useEffect(() => {
    setState(null);
    setSessionError(null);
    setLiveConnection(false);
    if (!selected) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;
    let fetching = false;
    let refreshAgain = false;

    function scheduleRefresh() {
      if (refreshTimer !== undefined || disposed) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 2000);
    }
    async function refresh() {
      if (fetching) { refreshAgain = true; return; }
      fetching = true;
      try {
        const next = await api.monitorState(selected);
        if (!disposed) { setState(next); setSessionError(null); }
      } catch (err) {
        if (!disposed) setSessionError(errorMessage(err));
      } finally {
        fetching = false;
        if (refreshAgain && !disposed) { refreshAgain = false; scheduleRefresh(); }
      }
    }
    function connect() {
      if (!examSessionId || disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/exam/${examSessionId}`);
      const activeSocket = socket;
      activeSocket.onopen = () => {
        if (disposed) return;
        setLiveConnection(true);
        pingTimer = window.setInterval(() => {
          if (activeSocket.readyState === WebSocket.OPEN) activeSocket.send("ping");
        }, 20000);
      };
      activeSocket.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data) as { event?: string };
          if (frame.event && frame.event !== "pong") scheduleRefresh();
        } catch { /* ignore malformed frames */ }
      };
      activeSocket.onclose = () => {
        window.clearInterval(pingTimer);
        if (disposed) return;
        setLiveConnection(false);
        reconnectTimer = window.setTimeout(connect, 2500);
      };
    }
    void refresh();
    connect();
    // Safety net: poll only while the socket is down and the tab is visible.
    const fallback = window.setInterval(() => {
      if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) void refresh();
    }, 10000);
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      window.clearInterval(fallback);
      socket?.close();
    };
  }, [selected, examSessionId]);

  const counts = useMemo(() => {
    if (!state) return null;
    return state.cards.reduce((result, card) => {
      if (card.online) result.online++;
      if (card.incident_count > 0) result.flagged++;
      if (["COMPLETED", "TIME_EXPIRED"].includes(card.status)) result.completed++;
      return result;
    }, { online: 0, flagged: 0, completed: 0 });
  }, [state]);
  const live = exams.filter((exam) => exam.status === "LIVE");

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Ringkasan operasional</div>
          <h1>Selamat datang, {me?.user.full_name?.split(" ")[0] ?? "Tim"}.</h1>
          <p>Semua yang Anda perlukan untuk menjaga ujian tetap terpantau.</p>
        </div>
        <Link to="/exams" className="btn btn-primary"><Icon name="exams" /> Kelola ujian</Link>
      </header>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {sessionError ? <Alert tone="error">Ringkasan peserta gagal diperbarui. {sessionError}</Alert> : null}
      {loading ? <LoadingBlock rows={3} /> : <>
        <div className="row-between participant-list-heading">
          <div>
            <h2 style={{ fontSize: 17 }}>Ringkasan peserta</h2>
            <p className="small muted">
              {currentExam ? `Sesi ${currentExam.exam_code} · ${currentExam.name}` : "Pilih ujian untuk melihat ringkasan sesi."}
            </p>
          </div>
          {monitorableExams.length > 0 ? (
            <select aria-label="Ujian ringkasan" className="monitor-sort" value={selected} onChange={(event) => setSelected(event.target.value)}>
              {monitorableExams.map((exam) => <option key={exam.id} value={exam.id}>{exam.exam_code} · {exam.name}</option>)}
            </select>
          ) : null}
        </div>
        <div className="stat-grid monitor-stats">
          <Stat label="Total peserta" value={state ? state.cards.length : "—"} hint={currentExam ? `${currentExam.participant_count} dalam roster` : `${stats?.total_participants ?? 0} dalam seluruh roster`} icon="users" />
          <Stat label="Online" value={counts?.online ?? "—"} hint="Terhubung ke sistem" icon="online" tone="online" />
          <Stat label="Offline" value={state && counts ? state.cards.length - counts.online : "—"} hint="Bukan indikasi kecurangan" icon="offline" tone="warning" />
          <Stat label="Dengan pelanggaran" value={counts?.flagged ?? "—"} hint="Peserta dengan insiden" icon="warning" tone="danger" />
          <Stat label="Selesai" value={counts?.completed ?? "—"} hint="Selesai atau waktu habis" icon="check" />
          <Stat label="Status ujian" value={currentExam ? <ExamStatusBadge status={state?.timer.status ?? currentExam.status} /> : "—"} hint={liveConnection ? "Realtime aktif" : `${stats?.active_exams ?? 0} ujian aktif`} icon="timer" tone="online" />
        </div>
        {currentExam ? (
          <section className="dashboard-focus">
            <div className="dashboard-focus-content">
              <div className="eyebrow">{currentExam.exam_code}</div>
              <h2>{currentExam.name}</h2>
              <p>
                {currentExam.duration_minutes} menit · {currentExam.participant_count} peserta dalam roster ·{" "}
                {state ? state.incidents.filter((incident) => incident.review_status === "UNREVIEWED").length : currentExam.incident_count} insiden {state ? "belum ditinjau" : "tercatat"}
              </p>
            </div>
            <div className="dashboard-focus-actions">
              <Link to={`/monitoring/${currentExam.id}`} className="btn btn-secondary">Buka pemantauan <Icon name="arrow" /></Link>
              <Link to={`/exams/${currentExam.id}`} className="btn btn-ghost">Detail ujian</Link>
            </div>
          </section>
        ) : null}
        <div className="dashboard-grid">
          <section className="card">
            <div className="card-header">
              <div><h2>Ujian berlangsung</h2><p>{live.length} sesi dengan timer server aktif.</p></div>
              <Icon name="monitor" />
            </div>
            {live.length === 0 ? (
              <EmptyState title="Belum ada ujian yang berlangsung" description="Mulai ujian dari halaman detail saat peserta siap." action={<Link to="/exams" className="btn btn-ghost btn-sm">Lihat daftar ujian</Link>} />
            ) : (
              <div className="table-wrap"><table>
                <thead><tr><th>Ujian</th><th>Berakhir (WIB)</th><th /></tr></thead>
                <tbody>{live.map((exam) => (
                  <tr key={exam.id}>
                    <td><strong>{exam.name}</strong><div className="small muted">{exam.exam_code} · {exam.participant_count} peserta</div></td>
                    <td className="small mono">{formatDateTime(exam.ends_at)}</td>
                    <td className="text-right"><Link to={`/monitoring/${exam.id}`} className="btn btn-ghost btn-sm">Pantau</Link></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section className="card">
            <div className="card-header">
              <div><h2>Ujian terbaru</h2><p>Persiapan dan status sesi Anda.</p></div>
              <Link to="/exams" className="small">Lihat semua</Link>
            </div>
            {exams.length === 0 ? (
              <EmptyState title="Belum ada ujian" description="Buat ujian pertama untuk mulai mengelola peserta." action={<Link to="/exams" className="btn btn-primary btn-sm">Buat ujian</Link>} />
            ) : (
              <div className="table-wrap"><table>
                <thead><tr><th>Ujian</th><th>Status</th><th /></tr></thead>
                <tbody>{exams.slice(0, 6).map((exam) => (
                  <tr key={exam.id}>
                    <td><strong>{exam.name}</strong><div className="small muted">{exam.exam_code} · {exam.duration_minutes} mnt</div></td>
                    <td><ExamStatusBadge status={exam.status} /></td>
                    <td className="text-right"><Link to={`/exams/${exam.id}`} className="btn btn-ghost btn-sm">Detail</Link></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </div>
      </>}
    </div>
  );
}
