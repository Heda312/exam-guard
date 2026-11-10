import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam, Incident, ParticipantCard, ParticipantDetail } from "../types";
import {
  Alert,
  ConnectionBadge,
  EmptyState,
  ExamStatusBadge,
  LoadingBlock,
  formatDateTime,
  formatDuration,
  formatTime,
  participantStatusLabel,
} from "../ui";

const EVENT_LABELS: Record<string, string> = {
  TAB_SWITCH: "Berpindah tab",
  NEW_TAB: "Membuka tab baru",
  TAB_CLOSED: "Menutup tab",
  FOCUS_LOST: "Fokus hilang",
  WINDOW_MINIMIZED: "Jendela diminimalkan",
  NAVIGATION: "Navigasi",
  CONNECTION_LOST: "Koneksi terputus",
  FOCUS_RESTORED: "Fokus kembali",
};

const REVIEW_LABELS: Record<string, string> = {
  UNREVIEWED: "Belum ditinjau",
  REVIEWED: "Sudah ditinjau",
  FLAGGED_FOR_FOLLOWUP: "Perlu tindak lanjut",
};

export default function MonitoringPage() {
  const { examId } = useParams();
  const { canManageExam } = useAuth();
  const [exams, setExams] = useState<Exam[]>([]);
  const [selected, setSelected] = useState<string>(examId ?? "");
  const [cards, setCards] = useState<ParticipantCard[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [detail, setDetail] = useState<ParticipantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api
      .listExams()
      .then((list) => {
        setExams(list);
        if (!selected && list.length > 0) setSelected(list[0].id);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [selected]);

  const currentExam = useMemo(
    () => exams.find((exam) => exam.id === selected) ?? null,
    [exams, selected],
  );

  const loadMonitoring = useCallback(async () => {
    if (!selected) {
      setLoading(false);
      return;
    }
    try {
      const [participantCards, incidentList, timer] = await Promise.all([
        api.monitor(selected),
        api.listIncidents(selected).catch(() => [] as Incident[]),
        api.examTimer(selected).catch(() => null),
      ]);
      setCards(participantCards);
      setIncidents(incidentList);
      setRemaining(timer?.remaining_seconds ?? null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    setLoading(true);
    void loadMonitoring();
    const interval = window.setInterval(() => {
      void loadMonitoring();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [loadMonitoring]);

  // Server-authoritative countdown: recomputed from the server value every poll.
  useEffect(() => {
    if (remaining === null) return;
    const timer = window.setInterval(() => {
      setRemaining((value) => (value === null ? null : Math.max(0, value - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [remaining !== null]);

  // Live updates over WebSocket (proctor socket, scoped to the exam session).
  useEffect(() => {
    const examSessionId = currentExam?.exam_session_id;
    if (!selected || !examSessionId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/exam/${examSessionId}`);
    socketRef.current = socket;
    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socket.onerror = () => setLive(false);
    socket.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data) as { event: string };
        if (
          [
            "monitoring_event",
            "incident_created",
            "participant_connection_lost",
            "participant_ready",
            "participant_monitoring_started",
            "exam_ended",
            "incident_reviewed",
          ].includes(payload.event)
        ) {
          void loadMonitoring();
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [selected, currentExam?.exam_session_id, loadMonitoring]);

  async function openDetail(card: ParticipantCard) {
    try {
      setDetail(await api.participantDetail(card.participant_session_id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function review(incident: Incident, status: string) {
    try {
      await api.reviewIncident(incident.id, { review_status: status, notes: incident.notes ?? undefined });
      setNotice("Status tinjauan insiden diperbarui.");
      await loadMonitoring();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (loading && exams.length === 0) return <LoadingBlock rows={4} />;

  const online = cards.filter((card) => card.online).length;
  const unreviewed = incidents.filter((incident) => incident.review_status === "UNREVIEWED").length;

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Pemantauan sesi</div>
          <h1>Pemantauan ujian</h1>
          <p>
            Status koneksi dan insiden aktivitas browser. Koneksi terputus tidak otomatis dianggap
            kecurangan.
          </p>
        </div>
        <div className="row">
          {remaining !== null ? (
            <div className={`timer ${remaining < 300 ? "is-critical" : ""}`}>
              <span className="timer-label">Sisa waktu</span>
              <span>{formatDuration(remaining)}</span>
            </div>
          ) : null}
          <span className={`badge ${live ? "badge-online" : "badge-neutral"}`} title="Status koneksi realtime">
            <span className="badge-dot" aria-hidden="true" />
            {live ? "Realtime aktif" : "Polling 5 dtk"}
          </span>
        </div>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="card" style={{ marginBottom: 22 }}>
        <div className="row-between">
          <div className="field" style={{ marginBottom: 0, minWidth: 260 }}>
            <label htmlFor="exam_select">Ujian</label>
            <select
              id="exam_select"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">— Pilih ujian —</option>
              {exams.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.exam_code} · {exam.name}
                </option>
              ))}
            </select>
          </div>
          {currentExam ? (
            <div className="row">
              <ExamStatusBadge status={currentExam.status} />
              <span className="small muted">
                {online} online · {cards.length - online} offline · {unreviewed} insiden belum ditinjau
              </span>
              <Link to={`/exams/${currentExam.id}`} className="btn btn-ghost btn-sm">
                Detail ujian
              </Link>
            </div>
          ) : null}
        </div>
      </div>

      {!selected ? (
        <EmptyState title="Pilih ujian" description="Pilih ujian untuk memulai pemantauan peserta." />
      ) : cards.length === 0 ? (
        <EmptyState
          title="Belum ada peserta aktif"
          description="Peserta akan muncul setelah mendaftar dengan Exam ID dan nama yang sesuai roster."
        />
      ) : (
        <section aria-label="Kartu peserta">
          <div className="participant-grid">
            {cards.map((card) => (
              <article
                key={card.participant_session_id}
                className={`participant-card ${card.incident_count > 0 ? "is-alert" : ""} ${
                  !card.online ? "is-offline" : ""
                }`}
              >
                <div className="participant-head">
                  <div>
                    <div className="participant-name">{card.full_name}</div>
                    <div className="participant-meta">
                      {card.npm ? `NPM ${card.npm}` : "NPM tidak diisi"}
                      {card.group_name ? ` · ${card.group_name}` : ""}
                    </div>
                  </div>
                  <ConnectionBadge online={card.online} status={card.status} />
                </div>

                <div className="stack gap-8">
                  <div className="small muted">
                    Status sesi: <strong>{participantStatusLabel(card.status)}</strong>
                  </div>
                  <div className="small muted">
                    Aktivitas terakhir: {card.latest_event_summary ?? "Belum ada aktivitas"}
                  </div>
                  <div className="small muted">Heartbeat: {formatTime(card.last_heartbeat_at)}</div>
                </div>

                <div className="participant-foot">
                  {card.incident_count > 0 ? (
                    <span className="incident-pill">
                      <span aria-hidden="true">▲</span>
                      {card.incident_count} insiden
                    </span>
                  ) : (
                    <span className="small muted">Tidak ada insiden</span>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => openDetail(card)}>
                    Lihat detail
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="card mt-24">
        <div className="card-header">
          <div>
            <h2>Insiden</h2>
            <p>Episode perilaku yang dikorelasikan dari event mentah extension.</p>
          </div>
        </div>
        {incidents.length === 0 ? (
          <EmptyState title="Tidak ada insiden" description="Belum ada aktivitas yang dikategorikan insiden." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Jenis</th>
                  <th>Jumlah event</th>
                  <th>Durasi</th>
                  <th>Tinjauan</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {incidents.slice(0, 40).map((incident) => {
                  const participant = cards.find(
                    (card) => card.participant_session_id === incident.participant_session_id,
                  );
                  const duration =
                    incident.ended_at && incident.started_at
                      ? (new Date(incident.ended_at).getTime() -
                          new Date(incident.started_at).getTime()) /
                        1000
                      : null;
                  return (
                    <tr key={incident.id}>
                      <td>
                        <div className="mono small">{formatDateTime(incident.started_at)}</div>
                        <div className="small muted">{participant?.full_name ?? "Peserta"}</div>
                      </td>
                      <td>{EVENT_LABELS[incident.incident_type] ?? incident.incident_type}</td>
                      <td className="mono">{incident.event_count}</td>
                      <td className="mono">{duration !== null ? formatDuration(duration) : "berlangsung"}</td>
                      <td>
                        <span
                          className={`badge ${
                            incident.review_status === "UNREVIEWED"
                              ? "badge-warning"
                              : incident.review_status === "REVIEWED"
                                ? "badge-success"
                                : "badge-danger"
                          }`}
                        >
                          {REVIEW_LABELS[incident.review_status] ?? incident.review_status}
                        </span>
                      </td>
                      <td className="text-right">
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => review(incident, "REVIEWED")}
                          >
                            Tinjau
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => review(incident, "FLAGGED_FOR_FOLLOWUP")}
                          >
                            Tandai
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Detail peserta ${detail.full_name}`}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(24,57,44,0.42)",
            display: "grid",
            placeItems: "center",
            padding: 20,
            zIndex: 40,
          }}
          onClick={() => setDetail(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 720, width: "100%", maxHeight: "86vh", overflowY: "auto" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="row-between">
              <div>
                <h2>{detail.full_name}</h2>
                <p className="small muted">
                  {detail.npm ? `NPM ${detail.npm}` : "NPM tidak diisi"} ·{" "}
                  {participantStatusLabel(detail.status)}
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}>
                Tutup
              </button>
            </div>

            <div className="alert alert-info mt-16" style={{ marginBottom: 16 }}>
              <div className="small">
                <strong>Komitmen integritas:</strong>{" "}
                {detail.commitment.accepted ? "Disetujui" : "Tidak disetujui"}
                {detail.commitment.accepted_at
                  ? ` pada ${formatDateTime(detail.commitment.accepted_at)}`
                  : ""}
                {detail.commitment.version ? ` (versi ${detail.commitment.version})` : ""}
              </div>
            </div>

            <h3 style={{ fontSize: 16, marginBottom: 10 }}>Riwayat event</h3>
            {detail.events.length === 0 ? (
              <p className="small muted">Belum ada event tercatat.</p>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Waktu</th>
                      <th>Event</th>
                      <th>Host</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.events.map((event) => (
                      <tr key={event.id}>
                        <td className="mono small">{formatTime(event.received_at)}</td>
                        <td>{EVENT_LABELS[event.event_type] ?? event.event_type}</td>
                        <td className="mono small muted">{event.page_host ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 style={{ fontSize: 16, margin: "18px 0 10px" }}>Insiden</h3>
            {detail.incidents.length === 0 ? (
              <p className="small muted">Tidak ada insiden untuk peserta ini.</p>
            ) : (
              <ul className="small" style={{ paddingLeft: 18 }}>
                {detail.incidents.map((incident) => (
                  <li key={incident.id}>
                    {EVENT_LABELS[incident.incident_type] ?? incident.incident_type} ·{" "}
                    {formatDateTime(incident.started_at)} · {incident.event_count} event ·{" "}
                    {REVIEW_LABELS[incident.review_status] ?? incident.review_status}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      {!canManageExam(selected, "can_review_incidents") && selected ? (
        <Alert tone="info">
          Akun Anda tidak memiliki izin meninjau insiden pada ujian ini.
        </Alert>
      ) : null}
    </div>
  );
}
