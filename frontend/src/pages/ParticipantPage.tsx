import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { errorMessage, participantApi, participantStore } from "../api";
import type { ParticipantConfig, ParticipantSession, PublicExamInfo } from "../types";
import { Alert, formatDuration, formatTime } from "../ui";

type Phase = "form" | "waiting" | "exam" | "finished";

/** Bridge to the ExamGuard Chrome extension (postMessage protocol). */
function notifyExtension(type: string, payload: Record<string, unknown> = {}) {
  window.postMessage({ source: "examguard-web", type, payload }, window.location.origin);
}

export default function ParticipantPage() {
  const { examCode: routeCode } = useParams();
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
  const heartbeatRef = useRef<number | null>(null);

  const isFinished = useMemo(
    () => ["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(session?.status ?? ""),
    [session?.status],
  );

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
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source === "examguard-extension") {
        if (data.type === "extension_ready") setExtensionDetected(true);
      }
    }
    window.addEventListener("message", onMessage);
    notifyExtension("web_ready");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Resume an existing session on reload.
  useEffect(() => {
    const storedId = participantStore.sessionId();
    if (!storedId) return;
    participantApi
      .session(storedId)
      .then((restored) => {
        setSession(restored);
        setPhase(resolvePhase(restored));
      })
      .catch(() => {
        participantStore.clear();
      });
  }, []);

  const lookupExam = useCallback(async (code: string) => {
    if (!code.trim()) return;
    try {
      const info = await participantApi.publicExam(code.trim());
      setExamInfo(info);
      setError(null);
    } catch (err) {
      setExamInfo(null);
      setError(errorMessage(err));
    }
  }, []);

  /* ---------------------------- Countdown ---------------------------- */
  const syncCountdown = useCallback((target: ParticipantSession) => {
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
    if (!session || isFinished) return;
    const interval = Math.max(5, session.heartbeat_interval_seconds || 10) * 1000;

    async function beat() {
      if (!session) return;
      try {
        await participantApi.heartbeat(session.participant_session_id);
      } catch {
        /* the server decides connection state; the client only retries */
      }
    }

    void beat();
    heartbeatRef.current = window.setInterval(beat, interval);
    return () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    };
  }, [session, isFinished]);

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
      setSession(created);
      setPhase(resolvePhase(created));
      notifyExtension("session_registered", {
        participantSessionId: created.participant_session_id,
        examCode: created.exam_code,
        googleFormsUrl: created.google_forms_url,
        token: participantStore.token(),
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReady() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await participantApi.ready(
        session.participant_session_id,
        window.location.href,
      );
      setSession(updated);
      setPhase(resolvePhase(updated));
      notifyExtension("page_ready", { participantSessionId: updated.participant_session_id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStartMonitoring() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await participantApi.startMonitoring(session.participant_session_id);
      setSession(updated);
      setPhase(resolvePhase(updated));
      notifyExtension("monitoring_started", {
        participantSessionId: updated.participant_session_id,
        googleFormsUrl: updated.google_forms_url,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSession() {
    if (!session) return;
    try {
      const updated = await participantApi.session(session.participant_session_id);
      setSession(updated);
      setPhase(resolvePhase(updated));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (remaining === 0 && session && !isFinished) {
      void refreshSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  /* ------------------------------ Render ----------------------------- */
  return (
    <div className="participant-shell">
      <div className="participant-panel">
        <div className="participant-hero">
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
                  placeholder="Sesuai nama pada roster"
                  required
                  autoComplete="name"
                />
                <span className="hint">
                  Nama dicocokkan dengan roster menggunakan normalisasi huruf besar/kecil dan spasi.
                </span>
              </div>

              <div className="field">
                <label htmlFor="npm">NPM (opsional)</label>
                <input
                  id="npm"
                  type="text"
                  value={npm}
                  onChange={(event) => setNpm(event.target.value)}
                  autoComplete="off"
                />
                <span className="hint">
                  NPM hanya bersifat informasi dan tidak digunakan untuk validasi identitas.
                </span>
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
                Dengan mendaftar, nama Anda dicocokkan dengan roster ujian. Bila identitas tidak
                dapat diverifikasi, hubungi pengawas — bukan mengulang dengan nama lain.
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

              <div className="card" style={{ background: "rgba(220,231,217,0.35)" }}>
                <h2 style={{ fontSize: 17, marginBottom: 8 }}>Ruang tunggu</h2>
                <p className="small muted">
                  Ujian belum dimulai oleh pengawas. Tetap di halaman ini; timer akan berjalan
                  otomatis ketika ujian dimulai.
                </p>
                <div className="row mt-16">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={refreshSession}>
                    Perbarui status
                  </button>
                  <span className="small muted">
                    Status sesi: <strong>{session.status}</strong>
                  </span>
                </div>
              </div>

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
                    Status: <strong>{session.status}</strong> · Koneksi: {session.connection_state}
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
                <h3 style={{ fontSize: 16, marginBottom: 6 }}>Langkah berikutnya</h3>
                <ol className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
                  <li>Pastikan extension ExamGuard aktif di Chrome Anda.</li>
                  <li>
                    Klik <strong>Buka formulir ujian</strong>. Halaman formulir akan dibuka pada tab
                    yang sama.
                  </li>
                  <li>
                    Setelah formulir termuat, kembali ke tab ini bila perlu dan klik{" "}
                    <strong>Aktifkan pemantauan</strong>.
                  </li>
                </ol>
                <div className="row mt-16">
                  {session.google_forms_url ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        notifyExtension("open_form", {
                          participantSessionId: session.participant_session_id,
                          url: session.google_forms_url,
                        });
                        window.location.href = session.google_forms_url!;
                      }}
                    >
                      Buka formulir ujian
                    </button>
                  ) : null}
                  {session.status === "INITIALIZING" ? (
                    <button type="button" className="btn btn-secondary" onClick={handleReady} disabled={busy}>
                      Halaman ujian sudah siap
                    </button>
                  ) : null}
                  {session.status === "READY" ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleStartMonitoring}
                      disabled={busy}
                    >
                      Aktifkan pemantauan
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-ghost" onClick={refreshSession}>
                    Perbarui status
                  </button>
                </div>
              </div>

              <div className="alert alert-info">
                <div className="small">
                  Extension memantau perpindahan tab, jendela baru, kehilangan fokus, dan navigasi
                  selama ujian. Event dikirim ke server beserta host halaman. Riwayat penjelajahan
                  lengkap tidak dikumpulkan.
                </div>
              </div>

              <div className="row">
                <span className={`badge ${extensionDetected ? "badge-success" : "badge-warning"}`}>
                  {extensionDetected ? "Extension terdeteksi" : "Extension belum terdeteksi"}
                </span>
                <span className="small muted">Terakhir disinkronkan {formatTime(session.server_time)}</span>
              </div>
            </div>
          ) : null}

          {isFinished && session ? (
            <div className="stack gap-16">
              <div className="alert alert-success">
                <div>
                  <strong>Ujian selesai.</strong>
                  <div className="small">
                    Status akhir: {session.status}. Anda boleh menutup halaman ini.
                  </div>
                </div>
              </div>
              <div className="card" style={{ background: "rgba(220,231,217,0.35)" }}>
                <div className="small muted">
                  Pastikan formulir ujian sudah dikirim sebelum menutup tab. ExamGuard tidak dapat
                  mengirimkan formulir atas nama Anda.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  participantStore.clear();
                  setSession(null);
                  setPhase("form");
                }}
              >
                Selesai
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Steps({ phase }: { phase: Phase }) {
  const steps = [
    { key: "form", label: "Verifikasi" },
    { key: "waiting", label: "Ruang tunggu" },
    { key: "exam", label: "Ujian" },
    { key: "finished", label: "Selesai" },
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
  if (["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(session.status)) return "finished";
  if (["REGISTERED", "WAITING"].includes(session.status)) return "waiting";
  return "exam";
}
