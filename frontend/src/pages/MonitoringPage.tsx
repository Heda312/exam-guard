import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam, ExamTimer, Incident, ParticipantCard, ParticipantDetail } from "../types";
import {
  Alert,
  ConnectionBadge,
  EmptyState,
  ExamStatusBadge,
  LoadingBlock,
  formatDateTime,
  formatDuration,
  formatRelative,
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

type Filter = "all" | "online" | "attention" | "offline";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Semua" },
  { key: "online", label: "Online" },
  { key: "attention", label: "Bermasalah" },
  { key: "offline", label: "Offline" },
];

function summarize(eventType: string | null, pageHost: string | null): string | null {
  if (!eventType) return null;
  const label = EVENT_LABELS[eventType] ?? eventType;
  return pageHost ? `${label} · ${pageHost}` : label;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export default function MonitoringPage() {
  const { examId } = useParams();
  const { canManageExam } = useAuth();
  const [exams, setExams] = useState<Exam[]>([]);
  const [selected, setSelected] = useState<string>(examId ?? "");
  const [cards, setCards] = useState<ParticipantCard[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [timer, setTimer] = useState<ExamTimer | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [detail, setDetail] = useState<ParticipantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [lastSync, setLastSync] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [flashes, setFlashes] = useState<Record<string, number>>({});

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const refreshRef = useRef<number | null>(null);
  const flashTimers = useRef<Record<string, number>>({});
  const detailIdRef = useRef<string | null>(null);
  const seenIncidents = useRef<Set<string>>(new Set());

  /* ----------------------------- Data loading ----------------------------- */
  useEffect(() => {
    api
      .listExams()
      .then((list) => {
        setExams(list);
        setSelected((previous) => previous || list[0]?.id || "");
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const currentExam = useMemo(
    () => exams.find((exam) => exam.id === selected) ?? null,
    [exams, selected],
  );

  const applyTimer = useCallback((next: ExamTimer) => {
    setTimer(next);
    setDeadline(Date.now() + Math.max(0, next.remaining_seconds) * 1000);
    setLastSync(Date.now());
  }, []);

  const loadState = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!selected) {
        setLoading(false);
        return;
      }
      try {
        const state = await api.monitorState(selected);
        setCards(state.cards);
        setIncidents(state.incidents);
        applyTimer(state.timer);
        setError(null);
        const openDetailId = detailIdRef.current;
        if (openDetailId) {
          api
            .participantDetail(openDetailId)
            .then(setDetail)
            .catch(() => undefined);
        }
      } catch (err) {
        if (!options.silent) setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [selected, applyTimer],
  );

  useEffect(() => {
    setLoading(true);
    setCards([]);
    setIncidents([]);
    setTimer(null);
    setDeadline(null);
    setQuery("");
    setFilter("all");
    setDetail(null);
    setFlashes({});
    detailIdRef.current = null;
    seenIncidents.current = new Set();
    if (refreshRef.current) {
      window.clearTimeout(refreshRef.current);
      refreshRef.current = null;
    }
    void loadState();
  }, [selected, loadState]);

  // Safety net: poll only while the WebSocket is not connected.
  useEffect(() => {
    if (!selected) return;
    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) void loadState({ silent: true });
    }, 10000);
    return () => window.clearInterval(interval);
  }, [selected, loadState]);

  // One ambient clock drives both the countdown and the relative timestamps.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const remaining = deadline === null ? null : Math.max(0, Math.round((deadline - now) / 1000));

  /* ------------------------------ Live updates ----------------------------- */
  const patchCard = useCallback(
    (participantSessionId: string, patch: (card: ParticipantCard) => ParticipantCard) => {
      setCards((previous) =>
        previous.map((card) =>
          card.participant_session_id === participantSessionId ? patch(card) : card,
        ),
      );
    },
    [],
  );

  const flashCard = useCallback((participantSessionId: string) => {
    setFlashes((previous) => ({ ...previous, [participantSessionId]: Date.now() }));
    const existing = flashTimers.current[participantSessionId];
    if (existing) window.clearTimeout(existing);
    flashTimers.current[participantSessionId] = window.setTimeout(() => {
      setFlashes((previous) => {
        const next = { ...previous };
        delete next[participantSessionId];
        return next;
      });
      delete flashTimers.current[participantSessionId];
    }, 2200);
  }, []);

  const scheduleRefresh = useCallback(
    (delay = 250) => {
      if (refreshRef.current) window.clearTimeout(refreshRef.current);
      refreshRef.current = window.setTimeout(() => {
        refreshRef.current = null;
        void loadState({ silent: true });
      }, delay);
    },
    [loadState],
  );

  const examSessionId = timer?.exam_session_id ?? currentExam?.exam_session_id ?? null;

  const handleFrame = useCallback(
    (event: string, data: Record<string, unknown>) => {
      if (event === "connected") {
        const seconds = Number(data.remaining_seconds ?? 0);
        const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
        // Keep the timer loaded from the API (started_at drives the progress
        // bar); the socket frame only refreshes the countdown.
        setDeadline(Date.now() + safeSeconds * 1000);
        setLastSync(Date.now());
        setTimer((previous) => ({
          exam_id: selected,
          exam_session_id: examSessionId ?? previous?.exam_session_id,
          status: (typeof data.status === "string"
            ? data.status
            : previous?.status ?? "LIVE") as ExamTimer["status"],
          session_status:
            typeof data.status === "string" ? data.status : previous?.session_status,
          server_time: new Date().toISOString(),
          started_at:
            previous?.started_at ??
            (typeof data.started_at === "string" ? data.started_at : null),
          ends_at:
            typeof data.ends_at === "string" ? data.ends_at : previous?.ends_at ?? null,
          remaining_seconds: safeSeconds,
        }));
        return;
      }
      if (event === "pong") return;

      if (event === "monitoring_event") {
        const id = typeof data.participant_session_id === "string" ? data.participant_session_id : null;
        if (!id) {
          scheduleRefresh();
          return;
        }
        const batch = Array.isArray(data.events)
          ? (data.events as Array<Record<string, unknown>>)
          : [];
        const latest = batch.length > 0 ? batch[batch.length - 1] : data;
        const eventType = typeof latest.event_type === "string" ? latest.event_type : null;
        const receivedAt =
          typeof latest.received_at === "string" ? latest.received_at : new Date().toISOString();
        const pageHost = typeof latest.page_host === "string" ? latest.page_host : null;
        patchCard(id, (card) => ({
          ...card,
          online: true,
          connection_state: "ONLINE",
          last_activity_at: receivedAt,
          latest_event_summary: summarize(eventType, pageHost) ?? card.latest_event_summary,
        }));
        flashCard(id);
        scheduleRefresh(300);
        return;
      }

      if (event === "incident_created") {
        const id = typeof data.participant_session_id === "string" ? data.participant_session_id : null;
        const incidentId = typeof data.incident_id === "string" ? data.incident_id : null;
        if (id && incidentId && !seenIncidents.current.has(incidentId)) {
          seenIncidents.current.add(incidentId);
          const incidentType =
            typeof data.incident_type === "string" ? data.incident_type : null;
          const startedAt =
            typeof data.started_at === "string" ? data.started_at : new Date().toISOString();
          patchCard(id, (card) => ({
            ...card,
            incident_count: card.incident_count + 1,
            last_incident_type: incidentType,
            last_incident_at: startedAt,
          }));
        }
        if (id) flashCard(id);
        scheduleRefresh(300);
        return;
      }

      if (event === "incident_reviewed") {
        const incidentId = typeof data.incident_id === "string" ? data.incident_id : null;
        const reviewStatus = typeof data.review_status === "string" ? data.review_status : null;
        if (incidentId && reviewStatus) {
          setIncidents((previous) =>
            previous.map((incident) =>
              incident.id === incidentId ? { ...incident, review_status: reviewStatus } : incident,
            ),
          );
        }
        return;
      }

      if (event === "participant_connection_lost") {
        const id = typeof data.participant_session_id === "string" ? data.participant_session_id : null;
        if (id) {
          patchCard(id, (card) => ({
            ...card,
            online: false,
            connection_state: "OFFLINE",
            status: "CONNECTION_LOST",
          }));
          flashCard(id);
        }
        scheduleRefresh(200);
        return;
      }

      if (event === "exam_ended") {
        setDeadline(Date.now());
        scheduleRefresh(200);
        return;
      }

      if (
        event === "participant_ready" ||
        event === "participant_monitoring_started" ||
        event === "participant_reconnected"
      ) {
        scheduleRefresh(150);
      }
    },
    [applyTimer, examSessionId, patchCard, flashCard, scheduleRefresh, selected],
  );

  useEffect(() => {
    if (!examSessionId) return;
    let disposed = false;
    let pingTimer: number | null = null;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/exam/${examSessionId}`);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        setLive(true);
        pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 20000);
      };

      socket.onclose = () => {
        if (pingTimer) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setLive(false);
        reconnectRef.current = window.setTimeout(connect, 2000);
      };

      socket.onerror = () => setLive(false);

      socket.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data) as {
            event?: string;
            data?: Record<string, unknown>;
          };
          if (frame.event) handleFrame(frame.event, frame.data ?? {});
        } catch {
          /* ignore malformed frames */
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectRef.current) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (pingTimer) window.clearInterval(pingTimer);
      socketRef.current?.close();
      socketRef.current = null;
      setLive(false);
    };
  }, [examSessionId, handleFrame]);

  useEffect(
    () => () => {
      if (refreshRef.current) window.clearTimeout(refreshRef.current);
      Object.values(flashTimers.current).forEach((id) => window.clearTimeout(id));
    },
    [],
  );

  /* ------------------------------- Actions -------------------------------- */
  async function openDetail(card: ParticipantCard) {
    detailIdRef.current = card.participant_session_id;
    try {
      setDetail(await api.participantDetail(card.participant_session_id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function closeDetail() {
    detailIdRef.current = null;
    setDetail(null);
  }

  async function review(incident: Incident, status: string) {
    try {
      const updated = await api.reviewIncident(incident.id, {
        review_status: status,
        notes: incident.notes ?? undefined,
      });
      setIncidents((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice("Status tinjauan insiden diperbarui.");
      scheduleRefresh(0);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /* -------------------------------- Derived ------------------------------- */
  const online = cards.filter((card) => card.online).length;
  const flagged = cards.filter((card) => card.incident_count > 0).length;
  const unreviewed = incidents.filter((incident) => incident.review_status === "UNREVIEWED").length;

  const visibleCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (filter === "online" && !card.online) return false;
      if (filter === "offline" && card.online) return false;
      if (filter === "attention" && card.incident_count === 0) return false;
      if (!needle) return true;
      return [card.full_name, card.npm ?? "", card.group_name ?? ""].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [cards, filter, query]);

  const progress = useMemo(() => {
    if (!timer?.started_at || !timer.ends_at || remaining === null) return null;
    const total = (new Date(timer.ends_at).getTime() - new Date(timer.started_at).getTime()) / 1000;
    if (total <= 0) return null;
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }, [timer?.started_at, timer?.ends_at, remaining]);

  if (loading && exams.length === 0) return <LoadingBlock rows={4} />;

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
          <span
            className={`badge ${live ? "badge-online" : "badge-warning"}`}
            title="Status koneksi realtime"
          >
            <span className={`badge-dot ${live ? "is-pulsing" : ""}`} aria-hidden="true" />
            {live ? "Realtime aktif" : "Menghubungkan ulang…"}
          </span>
        </div>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="card monitor-toolbar">
        <div className="row-between monitor-toolbar-row">
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
            <div className="row monitor-toolbar-actions">
              <ExamStatusBadge status={currentExam.status} />
              <span className="small muted" title={formatTime(new Date(lastSync).toISOString())}>
                Diperbarui {formatRelative(new Date(lastSync).toISOString(), now)}
              </span>
              <Link to={`/exams/${currentExam.id}`} className="btn btn-ghost btn-sm">
                Detail ujian
              </Link>
            </div>
          ) : null}
        </div>

        {selected ? (
          <div className="monitor-summary">
            <div className="summary-chip">
              <span className="summary-label">Peserta</span>
              <strong className="mono">{cards.length}</strong>
            </div>
            <div className="summary-chip is-online">
              <span className="summary-label">Online</span>
              <strong className="mono">{online}</strong>
            </div>
            <div className="summary-chip is-offline">
              <span className="summary-label">Offline</span>
              <strong className="mono">{cards.length - online}</strong>
            </div>
            <div className="summary-chip is-warning">
              <span className="summary-label">Pernah insiden</span>
              <strong className="mono">{flagged}</strong>
            </div>
            <div className="summary-chip is-danger">
              <span className="summary-label">Belum ditinjau</span>
              <strong className="mono">{unreviewed}</strong>
            </div>
          </div>
        ) : null}

        {selected && cards.length > 0 ? (
          <div className="row-between monitor-filter-row">
            <div className="filter-group" role="group" aria-label="Filter kartu peserta">
              {FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`btn btn-sm ${filter === item.key ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setFilter(item.key)}
                  aria-pressed={filter === item.key}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="monitor-search"
              placeholder="Cari nama, NPM, atau kelompok…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Cari peserta"
            />
          </div>
        ) : null}

        {progress !== null ? (
          <div className="monitor-progress" aria-hidden="true">
            <div
              className={`monitor-progress-fill ${remaining !== null && remaining < 300 ? "is-critical" : ""}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
      </div>

      {!selected ? (
        <EmptyState title="Pilih ujian" description="Pilih ujian untuk memulai pemantauan peserta." />
      ) : cards.length === 0 ? (
        <EmptyState
          title="Belum ada peserta aktif"
          description="Peserta akan muncul setelah mendaftar dengan Exam ID dan nama yang sesuai roster."
        />
      ) : visibleCards.length === 0 ? (
        <EmptyState
          title="Tidak ada peserta yang cocok"
          description="Ubah kata kunci pencarian atau filter yang dipilih."
        />
      ) : (
        <section aria-label="Kartu peserta" aria-live="polite">
          <div className="participant-grid">
            {visibleCards.map((card) => (
              <article
                key={card.participant_session_id}
                className={`participant-card ${card.incident_count > 0 ? "is-alert" : ""} ${
                  !card.online ? "is-offline" : ""
                } ${flashes[card.participant_session_id] ? "is-flash" : ""}`}
              >
                <div className="participant-head">
                  <div className="participant-avatar" aria-hidden="true">
                    {initials(card.full_name)}
                  </div>
                  <div className="participant-identity">
                    <div className="participant-name">
                      {card.full_name}
                      {card.is_late ? (
                        <span
                          className="badge badge-warning"
                          style={{ marginLeft: 8 }}
                          title={`Bergabung ${formatRelative(card.joined_at, now)} setelah ujian dimulai`}
                        >
                          Terlambat
                        </span>
                      ) : null}
                    </div>
                    <div className="participant-meta">
                      {card.npm ? `NPM ${card.npm}` : "NPM tidak diisi"}
                      {card.group_name ? ` · ${card.group_name}` : ""}
                    </div>
                  </div>
                  <ConnectionBadge online={card.online} status={card.status} />
                </div>

                <div className="participant-metrics">
                  <div className="participant-metric">
                    <span className="metric-label">Status sesi</span>
                    <span className="metric-value">{participantStatusLabel(card.status)}</span>
                  </div>
                  <div className="participant-metric">
                    <span className="metric-label">Heartbeat</span>
                    <span className={`metric-value ${card.online ? "" : "is-warning"}`}>
                      {formatRelative(card.last_heartbeat_at, now)}
                    </span>
                  </div>
                  <div className="participant-metric is-wide">
                    <span className="metric-label">Aktivitas terakhir</span>
                    <span className="metric-value">
                      {card.latest_event_summary ?? "Belum ada aktivitas"}
                      {card.last_activity_at ? (
                        <span className="metric-time"> · {formatRelative(card.last_activity_at, now)}</span>
                      ) : null}
                    </span>
                  </div>
                </div>

                <div className="participant-foot">
                  <div className="stack gap-4">
                    {card.incident_count > 0 ? (
                      <span className="incident-pill">
                        <span aria-hidden="true">▲</span>
                        {card.incident_count} insiden
                      </span>
                    ) : (
                      <span className="small muted">Tidak ada insiden</span>
                    )}
                    <span className="small muted">
                      {card.last_incident_at
                        ? `Terakhir: ${
                            EVENT_LABELS[card.last_incident_type ?? ""] ??
                            card.last_incident_type ??
                            "insiden"
                          } · ${formatRelative(card.last_incident_at, now)}`
                        : `Terhubung ${formatRelative(card.connected_at, now)}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => openDetail(card)}
                  >
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
                  <th>Peserta</th>
                  <th>Jenis</th>
                  <th>Domain</th>
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
                        <div className="small muted">{formatRelative(incident.started_at, now)}</div>
                      </td>
                      <td>
                        {incident.participant_name ?? participant?.full_name ?? "Peserta"}
                      </td>
                      <td>{EVENT_LABELS[incident.incident_type] ?? incident.incident_type}</td>
                      <td className="mono small">
                        {incident.page_host ?? "—"}
                      </td>
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
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Detail peserta ${detail.full_name}`}
          onClick={closeDetail}
        >
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="row-between">
              <div>
                <h2>{detail.full_name}</h2>
                <p className="small muted">
                  {detail.npm ? `NPM ${detail.npm}` : "NPM tidak diisi"} ·{" "}
                  {participantStatusLabel(detail.status)}
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeDetail}>
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
