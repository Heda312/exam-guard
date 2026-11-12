import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, errorMessage, participantApi, participantStore } from "../api";
import type { ParticipantConfig, ParticipantSession, PublicExamInfo } from "../types";
import { Alert, formatDuration, formatTime, participantStatusLabel } from "../ui";
import { version as webVersion } from "../../package.json";

type Phase = "form" | "waiting" | "exam";

/** Bridge to the ExamGuard Chrome extension (postMessage protocol). */
function notifyExtension(type: string, payload: Record<string, unknown> = {}) {
  window.postMessage({ source: "examguard-web", type, payload }, window.location.origin);
}

export default function ParticipantPage() {
  const { examCode: routeCode } = useParams();
  const navigate = useNavigate();
  const [config, setConfig] = useState<ParticipantConfig | null>(null);
  const [examCode, setExamCode] = useState(routeCode ?? "");
  const [examInfo, setExamInfo] = useState<PublicExamInfo | null>(null);
  const [fullName, setFullName] = useState("");
  const [npm, setNpm] = useState("");
  const [commitment, setCommitment] = useState(false);
  const [session, setSession] = useState<ParticipantSession | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [extensionDetected, setExtensionDetected] = useState(false);
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [monitoringState, setMonitoringState] = useState<{
    monitoring: boolean;
    buffered: number;
    needsAttention: boolean;
  }>({ monitoring: false, buffered: 0, needsAttention: false });
  const [warning, setWarning] = useState<{ type: string; count: number } | null>(null);
  const [endModal, setEndModal] = useState(false);
  const [endReason, setEndReason] = useState<"TIME_EXPIRED" | "COMPLETED">("TIME_EXPIRED");
  const [endContext, setEndContext] = useState<"session" | "registration">("session");
  const heartbeatRef = useRef<number | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const examInfoRequestsRef = useRef(new Map<string, Promise<PublicExamInfo>>());
  const finishedNotifiedRef = useRef<string | null>(null);

  /** The proctor has started the exam; the participant now chooses when to open it. */
  const examOpened = useMemo(() => {
    if (!session) return false;
    if (session.exam_status === "LIVE") return true;
    return ["INITIALIZING", "READY", "MONITORING"].includes(session.status);
  }, [session]);

  /* ------------------------- Exam-finished flow ------------------------- */
  /** The only end-of-exam path: tell the extension to stop, return to the
   *  registration page, and show one friendly "ujian telah selesai" popup —
   *  never a red error, never a lingering finished screen. */
  function finishSession(target: ParticipantSession, reason: "TIME_EXPIRED" | "COMPLETED") {
    setEndReason(reason);
    setEndContext("session");
    setEndModal(true);
    if (finishedNotifiedRef.current === target.participant_session_id) return;
    finishedNotifiedRef.current = target.participant_session_id;
    notifyExtension("exam_ended", {
      participantSessionId: target.participant_session_id,
      status: reason,
    });
    participantStore.clear();
    setSession(null);
    setPhase("form");
    setRemaining(null);
    setWarning(null);
    setError(null);
    setExamInfo(null);
    setExamCode("");
    if (routeCode) navigate("/join", { replace: true });
  }

  /** Entering the Exam ID of an exam that is already over is a normal outcome,
   *  not a registration error: show the same friendly notice. */
  function showExamEndedNotice() {
    setEndReason("COMPLETED");
    setEndContext("registration");
    setEndModal(true);
    setExamInfo(null);
    setError(null);
    if (routeCode) navigate("/join", { replace: true });
  }

  function dismissEndModal() {
    setEndModal(false);
    setError(null);
    setExamInfo(null);
    setExamCode("");
  }

  /* ---------------------------- Bootstrap ---------------------------- */
  useEffect(() => {
    participantApi
      .config()
      .then(setConfig)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!routeCode) return;
    void lookupExam(routeCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeCode]);

  // Detect the extension bridge.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data as { source?: string; type?: string; payload?: Record<string, unknown> } | null;
      if (data?.source !== "examguard-extension") return;
      if (data.type === "extension_ready") {
        setExtensionDetected(true);
        const version = data.payload?.version;
        if (typeof version === "string") setExtensionVersion(version);
      }
    }
    window.addEventListener("message", onMessage);
    notifyExtension("web_ready");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Poll the extension for its monitoring state (replaces the removed popup).
  useEffect(() => {
    if (!extensionDetected) return;

    function onState(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data as
        | { source?: string; type?: string; payload?: Record<string, unknown> }
        | null;
      if (data?.source !== "examguard-extension" || data.type !== "extension_state") return;
      const payload = data.payload ?? {};
      if (typeof payload.version === "string") setExtensionVersion(payload.version);
      setMonitoringState({
        monitoring: Boolean(payload.monitoring),
        buffered: Number(payload.buffered ?? 0),
        needsAttention: Boolean(payload.needsAttention),
      });
    }

    window.addEventListener("message", onState);
    const poll = window.setInterval(() => notifyExtension("get_state"), 3000);
    notifyExtension("get_state");
    return () => {
      window.removeEventListener("message", onState);
      window.clearInterval(poll);
    };
  }, [extensionDetected]);

  // Resume an existing session on reload. A session that is already over goes
  // straight to the friendly finished notice + registration page.
  useEffect(() => {
    const storedId = participantStore.sessionId();
    if (!storedId) return;
    participantApi
      .session(storedId)
      .then((restored) => {
        if (["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(restored.status)) {
          finishSession(restored, restored.status === "COMPLETED" ? "COMPLETED" : "TIME_EXPIRED");
          return;
        }
        setSession(restored);
        setPhase(resolvePhase(restored));
      })
      .catch(() => {
        participantStore.clear();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lookupExam = useCallback(async (code: string) => {
    if (!code.trim()) return;
    try {
      const info = await participantApi.publicExam(code.trim());
      if (info.status === "COMPLETED" || info.status === "CANCELLED") {
        showExamEndedNotice();
        return;
      }
      setExamInfo(info);
      setError(null);
    } catch (err) {
      setExamInfo(null);
      setError(errorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recover duration metadata once per exam, including resumed sessions.
  useEffect(() => {
    if (!session || examInfo?.exam_code === session.exam_code) return;
    let disposed = false;
    let request = examInfoRequestsRef.current.get(session.exam_id);
    if (!request) {
      request = participantApi.publicExam(session.exam_code);
      examInfoRequestsRef.current.set(session.exam_id, request);
    }
    void request
      .then((info) => {
        if (!disposed) setExamInfo(info);
      })
      .catch(() => {
        // The persisted timer window still supplies duration if lookup fails.
      });
    return () => {
      disposed = true;
    };
    // Only identity changes matter; session polling must not repeat the lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.exam_id, session?.exam_code, examInfo?.exam_code]);

  const durationSeconds = useMemo(() => {
    if (examInfo && (!session || examInfo.exam_code === session.exam_code)) {
      return examInfo.duration_minutes * 60;
    }
    if (!session?.started_at || !session.ends_at) return null;
    const duration = (new Date(session.ends_at).getTime() - new Date(session.started_at).getTime()) / 1000;
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  }, [examInfo, session?.exam_code, session?.started_at, session?.ends_at]);

  /* ---------------------------- Countdown ---------------------------- */
  const syncCountdown = useCallback((target: ParticipantSession) => {
    if (["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(target.status)) {
      setRemaining(0);
      return;
    }
    if (!target.ends_at) {
      setRemaining(null);
      return;
    }
    const serverNow = new Date(target.server_time).getTime();
    const ends = new Date(target.ends_at).getTime();
    const offset = Date.now() - serverNow;
    setRemaining(Math.max(0, Math.round((ends - (Date.now() - offset)) / 1000)));
  }, []);

  useEffect(() => {
    if (!session) return;
    syncCountdown(session);
    const tick = window.setInterval(() => {
      setRemaining((value) => (value === null ? null : Math.max(0, value - 1)));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [session, syncCountdown]);

  /* --------------------------- Heartbeats ---------------------------- */
  useEffect(() => {
    if (!session) return;
    const interval = Math.max(5, session.heartbeat_interval_seconds || 10) * 1000;

    async function beat() {
      if (!session) return;
      try {
        const ack = await participantApi.heartbeat(session.participant_session_id);
        if (["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(ack.status)) {
          finishSession(session, ack.status === "COMPLETED" ? "COMPLETED" : "TIME_EXPIRED");
        }
      } catch {
        /* the server decides connection state; the client only retries */
      }
    }

    void beat();
    heartbeatRef.current = window.setInterval(beat, interval);
    return () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /* ------------------- Participant realtime socket -------------------- */
  useEffect(() => {
    const participantSessionId = session?.participant_session_id;
    if (!participantSessionId) return;
    const token = participantStore.token();
    let disposed = false;
    let pingTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/participant/${participantSessionId}${query}`,
      );

      socket.onopen = () => {
        if (disposed) return;
        void refreshRef.current();
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, 20000);
      };

      socket.onclose = () => {
        if (pingTimer) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, 2500);
      };

      socket.onerror = () => undefined;

      socket.onmessage = (message) => {
        let frame: { event?: string; data?: Record<string, unknown> };
        try {
          frame = JSON.parse(message.data) as { event?: string; data?: Record<string, unknown> };
        } catch {
          return;
        }
        if (!frame.event) return;
        const data = frame.data ?? {};

        if (frame.event === "violation_warning") {
          const type = typeof data.incident_type === "string" ? data.incident_type : "TAB_SWITCH";
          const count = Number(data.event_count ?? 1);
          setWarning({ type, count: Number.isFinite(count) ? count : 1 });
          // The extension renders the same warning over the Google Forms tab.
          notifyExtension("violation_warning", {
            incidentType: type,
            eventCount: count,
            startedAt: typeof data.started_at === "string" ? data.started_at : null,
          });
          return;
        }

        if (frame.event === "time_expired" || frame.event === "exam_ended") {
          if (session) {
            finishSession(session, frame.event === "time_expired" ? "TIME_EXPIRED" : "COMPLETED");
          }
          return;
        }

        if (frame.event === "connected") {
          const status = typeof data.status === "string" ? data.status : "";
          const endsAt = typeof data.ends_at === "string" ? data.ends_at : null;
          const seconds = Number(data.remaining_seconds ?? 0);
          // Only a real deadline in the past means "time up". A session that has
          // not started yet reports remaining_seconds = 0 with ends_at = null;
          // that is the waiting room, not the end of the exam.
          const expired = endsAt !== null && seconds <= 0 && new Date(endsAt).getTime() <= Date.now();
          if ((["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(status) || expired) && session) {
            finishSession(session, status === "COMPLETED" ? "COMPLETED" : "TIME_EXPIRED");
          }
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (pingTimer) window.clearInterval(pingTimer);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.participant_session_id]);

  /* ------------------------ Registration flow ------------------------ */
  async function handleRegister(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await participantApi.register({
        exam_code: examCode.trim().toUpperCase(),
        full_name: fullName.trim(),
        npm: npm.trim() || null,
        commitment_accepted: commitment,
        commitment_version: config?.commitment_version ?? null,
      });
      finishedNotifiedRef.current = null;
      setSession(created);
      setPhase(resolvePhase(created));
      notifyExtension("session_registered", {
        participantSessionId: created.participant_session_id,
        examCode: created.exam_code,
        googleFormsUrl: created.google_forms_url,
        token: participantStore.token(),
      });
    } catch (err) {
      if (err instanceof ApiError && (err.code === "exam_ended" || err.code === "session_ended")) {
        showExamEndedNotice();
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshSession() {
    if (!session) return;
    try {
      const updated = await participantApi.session(session.participant_session_id);
      if (["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(updated.status)) {
        finishSession(updated, updated.status === "COMPLETED" ? "COMPLETED" : "TIME_EXPIRED");
        return;
      }
      setSession(updated);
      setPhase(resolvePhase(updated));
      // Deliberately no automatic navigation: the participant must press
      // "Buka ujian" themselves. Auto-redirecting on exam start surprised
      // participants and could fire while they were still reading the page.
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Poll the waiting room so the exam start is picked up without manual refresh.
  useEffect(() => {
    if (phase !== "waiting" || !session) return;
    const poll = window.setInterval(() => {
      void refreshSession();
    }, 5000);
    return () => window.clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session?.participant_session_id]);

  // Keep the latest session refresher reachable from socket callbacks.
  useEffect(() => {
    refreshRef.current = () => {
      void refreshSession();
    };
  });

  useEffect(() => {
    // `remaining` starts as null and is only 0 when a real deadline exists and
    // has passed; guard on ends_at so the waiting room never trips this.
    if (remaining !== 0 || !session?.ends_at || !session) return;
    finishSession(session, "TIME_EXPIRED");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  /* ------------------------------ Render ----------------------------- */
  return (
    <div className="participant-shell">
      <div
        className="participant-panel"
        data-extension={extensionDetected ? "ready" : "missing"}
        data-extension-version={extensionVersion ?? ""}
        data-participant-status={session?.status ?? ""}
        data-phase={phase}
      >
        <div className="participant-hero">
          <div className="participant-brand">
            <span className="participant-brand-mark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3 4.5 6v5.5c0 4.2 3 7.8 7.5 9.5 4.5-1.7 7.5-5.3 7.5-9.5V6L12 3Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="m8.5 12 2.3 2.3 4.7-4.6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>ExamGuard</span>
          </div>
          <div className="participant-versions" aria-label="Versi aplikasi peserta">
            <span>Web v{webVersion}</span>
            <span>{extensionVersion ? `Extension v${extensionVersion}` : "Extension belum terdeteksi"}</span>
          </div>
          <div className="row-between">
            <div>
              <h1>{phase === "form" ? "Pendaftaran peserta ujian" : session?.exam_name ?? "Ujian"}</h1>
              <p>
                {phase === "form"
                  ? "Masukkan Exam ID dan nama lengkap sesuai roster ujian."
                  : `Exam ID ${session?.exam_code} · ${
                      session?.participant.group_name ?? "Tanpa kelompok"
                    }`}
              </p>
            </div>
            <span className="badge badge-live">{config?.commitment_version ?? "v1"}</span>
          </div>
        </div>

        <div className="participant-body">
          <Steps phase={phase} />

          {session || examInfo ? (
            <dl className="participant-overview" aria-label="Ringkasan ujian">
              <div className="participant-overview-item">
                <dt className="small muted">Durasi ujian</dt>
                <dd className="participant-overview-value">
                  {durationSeconds !== null ? formatDuration(durationSeconds) : "—"}
                </dd>
              </div>
              <div className={`participant-overview-item ${remaining !== null && remaining < 300 ? "is-critical" : ""}`}>
                <dt className="small muted">Sisa waktu</dt>
                <dd className="participant-overview-value">
                  {session?.ends_at
                    ? remaining !== null ? formatDuration(remaining) : "Menyinkronkan…"
                    : "Belum dimulai"}
                </dd>
              </div>
              <div className="participant-overview-item">
                <dt className="small muted">Status sesi</dt>
                <dd className="participant-overview-value">
                  {session ? participantStatusLabel(session.status) : "Belum terdaftar"}
                </dd>
              </div>
            </dl>
          ) : null}

          {error ? <Alert tone="error">{error}</Alert> : null}

          {phase === "form" ? (
            <form onSubmit={handleRegister} noValidate>
              <div className="field">
                <label htmlFor="exam_code">Exam ID</label>
                <input
                  id="exam_code"
                  type="text"
                  value={examCode}
                  onChange={(event) => {
                    setExamCode(event.target.value.toUpperCase());
                  }}
                  onBlur={() => void lookupExam(examCode)}
                  placeholder="EXG-2026-001"
                  required
                  autoComplete="off"
                  aria-describedby="exam_code_hint"
                />
                <span className="hint" id="exam_code_hint">
                  Exam ID diberikan oleh pengawas. Exam ID bukan kata sandi.
                </span>
              </div>

              {examInfo ? (
                <div className="alert alert-info" style={{ marginBottom: 16 }}>
                  <div>
                    <strong>{examInfo.name}</strong>
                    <div className="small">
                      Durasi {examInfo.duration_minutes} menit ·{" "}
                      {examInfo.registration_open
                        ? "Pendaftaran dibuka"
                        : examInfo.registration_message ?? "Pendaftaran belum dibuka"}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="full_name">Nama lengkap</label>
                <input
                  id="full_name"
                  type="text"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Masukkan nama lengkap anda"
                  required
                  autoComplete="name"
                />
                <span className="hint">
                  Gunakan nama sesuai roster ujian. Huruf besar dan kecil tidak memengaruhi pencocokan.
                </span>
              </div>

              <div className="field">
                <label htmlFor="npm">NPM</label>
                <input
                  id="npm"
                  type="text"
                  value={npm}
                  onChange={(event) => setNpm(event.target.value)}
                  placeholder="Masukkan NPM anda"
                  autoComplete="off"
                />
              </div>

              <div className="checkbox-row" style={{ marginBottom: 16 }}>
                <input
                  id="commitment"
                  type="checkbox"
                  checked={commitment}
                  onChange={(event) => setCommitment(event.target.checked)}
                  required
                />
                <label htmlFor="commitment">
                  {config?.integrity_commitment ??
                    "Saya menyatakan mengerjakan ujian ini secara jujur dan mandiri, serta memahami bahwa aktivitas browser saya dipantau selama ujian."}
                </label>
              </div>

              {config?.google_auth_required ? (
                <Alert tone="warning">
                  Institusi Anda mengaktifkan verifikasi identitas Google. Hubungi pengawas bila
                  tombol masuk Google tidak tersedia.
                </Alert>
              ) : null}

              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={busy || !commitment || !examCode.trim() || !fullName.trim()}
              >
                {busy ? "Memverifikasi…" : "Daftar ujian"}
              </button>

              <p className="small muted mt-16">
                Dengan mendaftar, nama Anda dicocokkan dengan database ujian. Bila identitas tidak
                dapat diverifikasi, hubungi pengawas.
              </p>
            </form>
          ) : null}

          {phase === "waiting" && session ? (
            <div className="stack gap-16">
              <div className="alert alert-success">
                <div>
                  <strong>Identitas terverifikasi.</strong>
                  <div className="small">
                    Nama pada roster: <strong>{session.participant.full_name}</strong>
                    {session.participant.npm ? ` · NPM ${session.participant.npm}` : ""}
                  </div>
                </div>
              </div>

              {examOpened ? (
                <div className="card" style={{ background: "rgba(220,231,217,0.45)" }}>
                  <h2 style={{ fontSize: 18, marginBottom: 8 }}>Ujian sudah dibuka</h2>
                  <p className="small muted" style={{ marginBottom: 12 }}>
                    Pengawas telah memulai ujian. Waktu ujian <strong>terus berjalan di server</strong>,
                    termasuk sebelum Anda membuka formulir atau saat koneksi terputus. Tekan
                    <strong> Buka ujian</strong> ketika Anda siap mengerjakan.
                  </p>
                  <div className="row">
                    {session.google_forms_url ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          // The extension owns the exam tab, so it performs the navigation.
                          notifyExtension("exam_started", {
                            participantSessionId: session.participant_session_id,
                            googleFormsUrl: session.google_forms_url,
                          });
                        }}
                      >
                        Buka ujian
                      </button>
                    ) : (
                      <span className="small muted">
                        Pengawas belum mengisi tautan formulir ujian. Hubungi pengawas.
                      </span>
                    )}
                    <button type="button" className="btn btn-ghost" onClick={refreshSession}>
                      Perbarui status
                    </button>
                  </div>
                  {!extensionDetected ? (
                    <div className="small mt-16" style={{ color: "var(--warning-500)" }}>
                      Extension ExamGuard belum terdeteksi. Pasang extension agar formulir dapat
                      dibuka dan aktivitas browser terpantau.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="card" style={{ background: "rgba(220,231,217,0.35)" }}>
                  <h2 style={{ fontSize: 17, marginBottom: 8 }}>Ruang tunggu</h2>
                  <p className="small muted">
                    Ujian belum dimulai oleh pengawas. Halaman ini akan memperbarui statusnya
                    sendiri; Anda tidak perlu memuat ulang.
                  </p>
                  <div className="row mt-16">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={refreshSession}>
                      Perbarui status
                    </button>
                    <span className="small muted">
                      Status sesi: <strong>{participantStatusLabel(session.status)}</strong>
                    </span>
                  </div>
                  <div className="row mt-16" style={{ gap: 8 }}>
                    <span className={`badge ${extensionDetected ? "badge-success" : "badge-warning"}`}>
                      {extensionDetected ? "Extension siap" : "Extension belum terdeteksi"}
                    </span>
                    <span className="small muted">
                      Setelah ujian dibuka, tombol <strong>Buka ujian</strong> akan muncul di sini.
                    </span>
                  </div>
                </div>
              )}

              <div className="alert alert-info">
                <div className="small">
                  Jangan menutup tab ini. Jika koneksi terputus, waktu ujian tetap berjalan dan Anda
                  dapat menyambung kembali dengan membuka halaman ini lagi.
                </div>
              </div>
            </div>
          ) : null}

          {phase === "exam" && session ? (
            <div className="stack gap-16">
              <div className="row-between">
                <div>
                  <div className="eyebrow">Sesi berlangsung</div>
                  <h2 style={{ fontSize: 20 }}>{session.participant.full_name}</h2>
                  <p className="small muted">
                    Status: <strong>{participantStatusLabel(session.status)}</strong> · Koneksi: {session.connection_state}
                  </p>
                </div>
                {remaining !== null ? (
                  <div className={`timer ${remaining < 300 ? "is-critical" : ""}`}>
                    <span className="timer-label">Sisa waktu</span>
                    <span>{formatDuration(remaining)}</span>
                  </div>
                ) : null}
              </div>

              {session.messages.map((message) => (
                <Alert key={message} tone="warning">
                  {message}
                </Alert>
              ))}

              <div className="card" style={{ background: "rgba(220,231,217,0.35)" }}>
                <h3 style={{ fontSize: 16, marginBottom: 6 }}>Formulir ujian</h3>
                <p className="small muted" style={{ marginBottom: 12 }}>
                  Tekan tombol di bawah untuk membuka formulir ujian pada tab ini melalui extension.
                  Pemantauan dimulai setelah formulir termuat; waktu ujian tetap mengikuti server.
                </p>
                <div className="row">
                  {session.google_forms_url ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        // The extension owns the exam tab, so it performs the navigation.
                        notifyExtension("exam_started", {
                          participantSessionId: session.participant_session_id,
                          googleFormsUrl: session.google_forms_url,
                        });
                      }}
                    >
                      Buka formulir ujian sekarang
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-ghost" onClick={refreshSession}>
                    Perbarui status
                  </button>
                </div>
                {!extensionDetected ? (
                  <div className="small mt-16" style={{ color: "var(--warning-500)" }}>
                    Extension ExamGuard belum terdeteksi. Pasang dan aktifkan extension agar formulir
                    dapat dibuka dan aktivitas browser terpantau.
                  </div>
                ) : null}
              </div>

              <div className="alert alert-info">
                <div className="small">
                  Extension memantau perpindahan tab, jendela baru, kehilangan fokus, dan navigasi
                  selama ujian. Event dikirim ke server beserta host halaman. Riwayat penjelajahan
                  lengkap tidak dikumpulkan.
                </div>
              </div>

              <div className="card" style={{ background: "rgba(220,231,217,0.3)" }}>
                <h3 style={{ fontSize: 15, marginBottom: 10 }}>Status pemantauan</h3>
                <div className="row" style={{ gap: 10 }}>
                  <span className={`badge ${extensionDetected ? "badge-success" : "badge-warning"}`}>
                    {extensionDetected
                      ? `Extension aktif${extensionVersion ? ` v${extensionVersion}` : ""}`
                      : "Extension belum terdeteksi"}
                  </span>
                  <span className={`badge ${monitoringState.monitoring ? "badge-online" : "badge-neutral"}`}>
                    {monitoringState.monitoring ? "Pemantauan berjalan" : "Pemantauan belum aktif"}
                  </span>
                  {monitoringState.needsAttention ? (
                    <span className="badge badge-danger">Perlu tindakan</span>
                  ) : null}
                </div>
                <div className="small muted mt-16">
                  {monitoringState.buffered > 0
                    ? `${monitoringState.buffered} event menunggu dikirim ke server.`
                    : "Semua event sudah terkirim ke server."}
                  {" "}Terakhir disinkronkan {formatTime(session.server_time)}.
                </div>
                {monitoringState.needsAttention ? (
                  <div className="small mt-16" style={{ color: "var(--danger-600)" }}>
                    Sesi pemantauan perlu disegarkan. Muat ulang halaman ini, atau hubungi pengawas
                    bila masalah berlanjut.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

        </div>
      </div>

      {warning ? (
        <div
          className="modal-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="violation_title"
        >
          <div className="modal-panel is-compact is-danger">
            <div className="modal-icon is-danger" aria-hidden="true">
              !
            </div>
            <h2 id="violation_title" className="modal-title">
              Sepertinya anda kehilangan fokus
            </h2>
            <p className="modal-lead">Harap kembali mengerjakan ujian.</p>
            <div className="alert alert-danger">
              <div className="small">
                Aktivitas ini tercatat dan dilaporkan kepada pengawas. Jangan berpindah tab,
                membuka jendela lain, atau meninggalkan formulir sampai ujian selesai.
              </div>
            </div>
            {warning.count > 1 ? (
              <p className="small muted">
                Episode ini mencakup {warning.count} aktivitas yang terdeteksi.
              </p>
            ) : null}
            <button
              type="button"
              className="btn btn-danger btn-block"
              onClick={() => setWarning(null)}
            >
              Saya mengerti
            </button>
          </div>
        </div>
      ) : null}

      {endModal ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="exam_end_title"
        >
          <div className="modal-panel is-compact">
            <div className="modal-icon is-success" aria-hidden="true">
              ✓
            </div>
            <h2 id="exam_end_title" className="modal-title">
              Ujian telah selesai
            </h2>
            <p className="small muted">
              {endContext === "registration"
                ? "Ujian dengan Exam ID ini sudah selesai, sehingga pendaftaran tidak dapat dilakukan lagi."
                : endReason === "TIME_EXPIRED"
                  ? "Waktu pengerjaan telah habis. Sistem berhenti memantau aktivitas browser Anda."
                  : "Ujian telah diakhiri oleh pengawas. Sistem berhenti memantau aktivitas browser Anda."}
            </p>
            {endContext === "session" ? (
              <div className="alert alert-info">
                <div className="small">
                  Pastikan jawaban pada formulir ujian sudah terkirim sebelum menutup tab ini.
                  ExamGuard tidak dapat mengirimkan formulir atas nama Anda.
                </div>
              </div>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={dismissEndModal}
            >
              Kembali ke halaman pendaftaran
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Steps({ phase }: { phase: Phase }) {
  const steps = [
    { key: "form", label: "Verifikasi" },
    { key: "waiting", label: "Ruang tunggu" },
    { key: "exam", label: "Ujian" },
  ];
  const activeIndex = steps.findIndex((step) => step.key === phase);
  return (
    <div className="step-list" aria-label="Tahapan ujian">
      {steps.map((step, index) => (
        <div key={step.key} className="row" style={{ gap: 8 }}>
          <div
            className={`step ${index === activeIndex ? "is-active" : ""} ${
              index < activeIndex ? "is-done" : ""
            }`}
          >
            <span className="step-index" aria-hidden="true">
              {index < activeIndex ? "✓" : index + 1}
            </span>
            {step.label}
          </div>
          {index < steps.length - 1 ? (
            <span className="step-divider" aria-hidden="true">
              →
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function resolvePhase(session: ParticipantSession): Phase {
  // INITIALIZING/READY means "exam opened, participant has not entered yet".
  // Keeping them in the waiting view is what shows the explicit "Buka ujian"
  // button instead of navigating the tab behind their back. Terminal statuses
  // never reach this function: finishSession handles them first.
  if (["REGISTERED", "WAITING", "INITIALIZING", "READY"].includes(session.status)) return "waiting";
  return "exam";
}
