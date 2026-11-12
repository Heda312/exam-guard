import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam, ExamTimer, Incident, ParticipantCard, ParticipantDetail, ProctorPresence } from "../types";
import {
  Alert,
  ConnectionBadge,
  EmptyState,
  ExamStatusBadge,
  Icon,
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

const FINISHED_STATUSES = ["COMPLETED", "TIME_EXPIRED"];
const PAGE_SIZE = 48;

type Filter = "all" | "online" | "attention" | "offline" | "completed";
type Sort = "name" | "violations" | "offline" | "online";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Semua" },
  { key: "online", label: "Online" },
  { key: "attention", label: "Bermasalah" },
  { key: "offline", label: "Offline" },
  { key: "completed", label: "Selesai" },
];

const SORTS: { key: Sort; label: string }[] = [
  { key: "name", label: "Nama (A–Z)" },
  { key: "violations", label: "Insiden terbanyak" },
  { key: "offline", label: "Offline dulu" },
  { key: "online", label: "Online dulu" },
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

/** Owns its 1s tick so the participant grid never re-renders for the clock. */
function Countdown({ deadline }: { deadline: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [deadline]);
  if (deadline === null) return null;
  const remaining = Math.max(0, Math.round((deadline - now) / 1000));
  return (
    <div className={`timer ${remaining < 300 ? "is-critical" : ""}`}>
      <span className="timer-label">Sisa waktu</span>
      <span>{formatDuration(remaining)}</span>
    </div>
  );
}

function ExamProgress({ timer, deadline }: { timer: ExamTimer | null; deadline: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const active = Boolean(
    timer?.status === "LIVE" && timer?.started_at && timer?.ends_at && deadline !== null,
  );
  useEffect(() => {
    if (!active) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [active]);
  if (!active || !timer?.started_at || !timer.ends_at || deadline === null) return null;
  const total =
    (new Date(timer.ends_at).getTime() - new Date(timer.started_at).getTime()) / 1000;
  if (total <= 0) return null;
  const remaining = Math.max(0, (deadline - now) / 1000);
  const progress = Math.max(0, Math.min(100, (remaining / total) * 100));
  return (
    <div className="monitor-progress" aria-hidden="true">
      <div
        className={`monitor-progress-fill ${remaining < 300 ? "is-critical" : ""}`}
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

interface TileProps {
  card: ParticipantCard;
  examCode: string;
  now: number;
  flash: boolean;
  onDetail: (card: ParticipantCard) => void;
}

/** Compact tile; memoized so only changed cards re-render on WS patches. */
const ParticipantTile = memo(function ParticipantTile({
  card,
  examCode,
  now,
  flash,
  onDetail,
}: TileProps) {
  const finished = FINISHED_STATUSES.includes(card.status);
  const classes = [
    "participant-card",
    card.incident_count > 0 ? "is-alert" : "",
    !card.online && !finished ? "is-offline" : "",
    flash ? "is-flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lastIncidentLabel = card.last_incident_at
    ? `${EVENT_LABELS[card.last_incident_type ?? ""] ?? card.last_incident_type ?? "Insiden"} · ${formatRelative(card.last_incident_at, now)}`
    : null;

  return (
    <article className={classes}>
      <div className="participant-head">
        <div className="participant-avatar" aria-hidden="true">
          {initials(card.full_name)}
        </div>
        <div className="participant-identity">
          <div className="participant-name">
            {card.full_name}
            {card.is_late ? (
              <span
                className="badge badge-warning late-flag"
                title={`Bergabung ${formatRelative(card.joined_at, now)} setelah ujian dimulai`}
              >
                <Icon name="timer" className="badge-icon" />
                Terlambat
              </span>
            ) : null}
          </div>
          <div className="participant-meta">
            <span className="participant-exam-id mono">{examCode}</span>
            {card.npm ? ` · NPM ${card.npm}` : ""}
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
        {card.incident_count > 0 ? (
          <span className="incident-pill" title={lastIncidentLabel ?? undefined}>
            <span aria-hidden="true">▲</span>
            {card.incident_count} insiden
          </span>
        ) : (
          <span className="small muted">Tidak ada insiden</span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onDetail(card)}
        >
          Lihat detail
        </button>
      </div>
    </article>
  );
});

export default function MonitoringPage() {
  const { examId } = useParams();
  const { canManageExam, me } = useAuth();
  const [exams, setExams] = useState<Exam[]>([]);
  const [selected, setSelected] = useState<string>(examId ?? "");
  const [cards, setCards] = useState<ParticipantCard[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [timer, setTimer] = useState<ExamTimer | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [detail, setDetail] = useState<ParticipantDetail | null>(null);
  const [proctorsOnline, setProctorsOnline] = useState<ProctorPresence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [lastSync, setLastSync] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [page, setPage] = useState(0);
  const [flashes, setFlashes] = useState<Record<string, number>>({});

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const refreshRef = useRef<number | null>(null);
  const lastRefreshRef = useRef<number>(Date.now());
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
  const examCode = currentExam?.exam_code ?? "—";

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
        setProctorsOnline(state.proctors_online ?? []);
        applyTimer(state.timer);
        lastRefreshRef.current = Date.now();
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
    setSort("name");
    setPage(0);
    setDetail(null);
    setProctorsOnline([]);
    setFlashes({});
    detailIdRef.current = null;
    seenIncidents.current = new Set();
    if (refreshRef.current) {
      window.clearTimeout(refreshRef.current);
      refreshRef.current = null;
    }
    void loadState();
  }, [selected, loadState]);

  // Safety net: reconcile only while visible, and only when the socket is
  // down or no refresh has landed for 30s. With WS up this is nearly free.
  useEffect(() => {
    if (!selected) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const socket = socketRef.current;
      const stale = Date.now() - lastRefreshRef.current > 30000;
      if (!socket || socket.readyState !== WebSocket.OPEN || stale) {
        void loadState({ silent: true });
      }
    }, 10000);
    return () => window.clearInterval(interval);
  }, [selected, loadState]);

  // Coarse clock for relative timestamps; the 1s countdown lives in its own
  // components so 80+ tiles do not re-render every second.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 10000);
    return () => window.clearInterval(tick);
  }, []);

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
    (delay = 400) => {
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
        // Patch only — no refetch per event, so 80+ participants stay cheap.
        patchCard(id, (card) => ({
          ...card,
          online: true,
          connection_state: "ONLINE",
          last_activity_at: receivedAt,
          latest_event_summary: summarize(eventType, pageHost) ?? card.latest_event_summary,
        }));
        flashCard(id);
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
        scheduleRefresh(600);
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
        scheduleRefresh(400);
        return;
      }

      if (event === "exam_ended") {
        // Stop the countdown immediately; the refresh confirms the final state.
        setDeadline(Date.now());
        setTimer((previous) =>
          previous
            ? { ...previous, status: "COMPLETED", session_status: "COMPLETED", remaining_seconds: 0 }
            : previous,
        );
        scheduleRefresh(300);
        return;
      }

      if (event === "proctor_presence") {
        const viewers = Array.isArray(data.viewers) ? (data.viewers as ProctorPresence[]) : [];
        setProctorsOnline(
          viewers.filter(
            (viewer) => typeof viewer?.user_id === "string" && typeof viewer?.full_name === "string",
          ),
        );
        return;
      }

      if (
        event === "participant_ready" ||
        event === "participant_monitoring_started" ||
        event === "participant_reconnected"
      ) {
        scheduleRefresh(400);
      }
    },
    [examSessionId, patchCard, flashCard, scheduleRefresh, selected],
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
        void loadState({ silent: true });
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
  }, [examSessionId, handleFrame, loadState]);

  useEffect(
    () => () => {
      if (refreshRef.current) window.clearTimeout(refreshRef.current);
      Object.values(flashTimers.current).forEach((id) => window.clearTimeout(id));
    },
    [],
  );

  /* ------------------------------- Actions -------------------------------- */
  const openDetail = useCallback(async (card: ParticipantCard) => {
    detailIdRef.current = card.participant_session_id;
    try {
      setDetail(await api.participantDetail(card.participant_session_id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const closeDetail = useCallback(() => {
    detailIdRef.current = null;
    setDetail(null);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [detail, closeDetail]);

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
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /* -------------------------------- Derived ------------------------------- */
  const online = cards.filter((card) => card.online).length;
  const flagged = cards.filter((card) => card.incident_count > 0).length;
  const completed = cards.filter((card) => FINISHED_STATUSES.includes(card.status)).length;
  const late = cards.filter((card) => card.is_late).length;
  const unreviewed = incidents.filter((incident) => incident.review_status === "UNREVIEWED").length;

  const visibleCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = cards.filter((card) => {
      if (filter === "online" && !card.online) return false;
      if (filter === "offline" && card.online) return false;
      if (filter === "attention" && card.incident_count === 0) return false;
      if (filter === "completed" && !FINISHED_STATUSES.includes(card.status)) return false;
      if (!needle) return true;
      return [card.full_name, card.npm ?? "", card.group_name ?? "", examCode].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
    const byName = (a: ParticipantCard, b: ParticipantCard) =>
      a.full_name.localeCompare(b.full_name);
    switch (sort) {
      case "violations":
        filtered.sort((a, b) => b.incident_count - a.incident_count || byName(a, b));
        break;
      case "offline":
        filtered.sort((a, b) => Number(a.online) - Number(b.online) || byName(a, b));
        break;
      case "online":
        filtered.sort((a, b) => Number(b.online) - Number(a.online) || byName(a, b));
        break;
      default:
        filtered.sort(byName);
    }
    return filtered;
  }, [cards, filter, query, sort, examCode]);

  useEffect(() => {
    setPage(0);
  }, [filter, query, sort]);

  const pageCount = Math.max(1, Math.ceil(visibleCards.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageCards = visibleCards.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const participantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const card of cards) map.set(card.participant_session_id, card.full_name);
    return map;
  }, [cards]);

  if (loading && exams.length === 0) return <LoadingBlock rows={4} />;

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Pemantauan sesi</div>
          <h1>Pemantauan ujian</h1>
          <p>
            Status koneksi dan insiden aktivitas browser. Koneksi terputus tidak otomatis dianggap
            kecurangan. Semua waktu ditampilkan dalam <strong>WIB (UTC+7)</strong>.
          </p>
        </div>
        <div className="row">
          {timer?.status === "LIVE" ? <Countdown deadline={deadline} /> : null}
          <span
            className={`badge ${!examSessionId ? "badge-neutral" : live ? "badge-online" : "badge-warning"}`}
            title="Status koneksi realtime"
          >
            <span className={`badge-dot ${live ? "is-pulsing" : ""}`} aria-hidden="true" />
            {!examSessionId ? "Menunggu sesi ujian" : live ? "Realtime aktif" : "Menghubungkan ulang…"}
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
            <div className="summary-chip">
              <span className="summary-label">Selesai</span>
              <strong className="mono">{completed}</strong>
            </div>
            {late > 0 ? (
              <div className="summary-chip is-warning" title="Peserta yang bergabung setelah ujian dimulai">
                <span className="summary-label">Terlambat</span>
                <strong className="mono">{late}</strong>
              </div>
            ) : null}
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
          <div className="monitor-controls">
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
              placeholder="Cari nama, NPM, atau Exam ID…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Cari peserta"
            />
            <select
              className="monitor-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
              aria-label="Urutkan peserta"
            >
              {SORTS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <ExamProgress timer={timer} deadline={deadline} />
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
          <div className="participant-list-heading">
            <span className="monitor-count">
              Menampilkan {pageCards.length} dari {visibleCards.length} peserta
            </span>
          </div>
          <div className="participant-grid">
            {pageCards.map((card) => (
              <ParticipantTile
                key={card.participant_session_id}
                card={card}
                examCode={examCode}
                now={now}
                flash={Boolean(flashes[card.participant_session_id])}
                onDetail={openDetail}
              />
            ))}
          </div>
          {pageCount > 1 ? (
            <div className="pagination">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                ← Sebelumnya
              </button>
              <span className="small muted">
                Halaman {safePage + 1} dari {pageCount}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                Berikutnya →
              </button>
            </div>
          ) : null}
        </section>
      )}

      <section className="card mt-24">
        <div className="card-header">
          <div>
            <h2>Insiden</h2>
            <p>Episode perilaku yang dikorelasikan dari event mentah extension.</p>
          </div>
          {incidents.length > 40 ? (
            <span className="small muted">40 terbaru dari {incidents.length}</span>
          ) : null}
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
                        {incident.participant_name ??
                          participantNames.get(incident.participant_session_id) ??
                          "Peserta"}
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
        <div className="detail-backdrop" onClick={closeDetail}>
          <div
            className="detail-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`Detail peserta ${detail.full_name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-header">
              <div className="participant-avatar" aria-hidden="true">
                {initials(detail.full_name)}
              </div>
              <div className="participant-identity">
                <h2>{detail.full_name}</h2>
                <p className="small muted">
                  {detail.npm ? `NPM ${detail.npm}` : "NPM tidak diisi"}
                  {detail.group_name ? ` · ${detail.group_name}` : ""}
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeDetail} autoFocus>
                Tutup
              </button>
            </div>

            <div className="detail-body">
              <div className="detail-stats">
                <div className="detail-summary">
                  <span className="metric-label">Status sesi</span>
                  <span className="metric-value">{participantStatusLabel(detail.status)}</span>
                </div>
                <div className="detail-summary">
                  <span className="metric-label">Insiden</span>
                  <span className="metric-value mono">{detail.incidents.length}</span>
                </div>
                <div className="detail-summary">
                  <span className="metric-label">Heartbeat</span>
                  <span className="metric-value">{formatRelative(detail.last_heartbeat_at, now)}</span>
                </div>
              </div>

              <div className="alert alert-info">
                <div className="small">
                  <strong>Komitmen integritas:</strong>{" "}
                  {detail.commitment.accepted ? "Disetujui" : "Tidak disetujui"}
                  {detail.commitment.accepted_at
                    ? ` pada ${formatDateTime(detail.commitment.accepted_at)}`
                    : ""}
                  {detail.commitment.version ? ` (versi ${detail.commitment.version})` : ""}
                </div>
              </div>

              <p className="small muted">
                Terhubung {formatRelative(detail.connected_at, now)}
                {detail.joined_at ? ` · Bergabung ${formatRelative(detail.joined_at, now)}` : ""}
                {detail.is_late ? " · Terlambat" : ""}
              </p>

              <h3>Riwayat event</h3>
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
                          <td className="mono small" title="WIB (UTC+7)">
                            {formatTime(event.received_at)}
                          </td>
                          <td>{EVENT_LABELS[event.event_type] ?? event.event_type}</td>
                          <td className="mono small muted">{event.page_host ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3>Insiden</h3>
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
        </div>
      ) : null}

      {examSessionId && proctorsOnline.length > 0 ? (
        <div
          className="proctor-float"
          role="status"
          title="Proktor/admin yang sedang membuka pemantauan ujian ini"
        >
          <span className="proctor-float-dot" aria-hidden="true" />
          <div className="proctor-float-text">
            <span className="proctor-float-label">Proktor live</span>
            <span className="proctor-float-names">
              {proctorsOnline
                .slice(0, 2)
                .map((viewer) =>
                  viewer.user_id === me?.user.id ? `${viewer.full_name} (Anda)` : viewer.full_name,
                )
                .join(", ")}
              {proctorsOnline.length > 2 ? ` +${proctorsOnline.length - 2}` : ""}
            </span>
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
