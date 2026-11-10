import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import type { Exam, OverviewStats } from "../types";
import { Alert, EmptyState, ExamStatusBadge, LoadingBlock, Stat, formatDateTime } from "../ui";

export default function DashboardPage() {
  const { me } = useAuth();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [overview, examList] = await Promise.all([api.overview(), api.listExams()]);
        if (cancelled) return;
        setStats(overview);
        setExams(examList);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const live = exams.filter((exam) => exam.status === "LIVE");

  return (
    <div>
      <header className="page-header">
        <div>
          <div className="eyebrow">Ringkasan operasional</div>
          <h1>Selamat datang, {me?.user.full_name?.split(" ")[0] ?? "Tim"}.</h1>
          <p>
            Pantau ujian yang sedang berjalan, status koneksi peserta, dan insiden yang perlu
            ditinjau.
          </p>
        </div>
        <Link to="/exams" className="btn btn-primary">
          Kelola ujian
        </Link>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {loading ? (
        <LoadingBlock rows={4} />
      ) : (
        <>
          <div className="stat-grid">
            <Stat label="Ujian aktif" value={stats?.active_exams ?? 0} hint={`${stats?.total_exams ?? 0} ujian total`} />
            <Stat
              label="Peserta online"
              value={stats?.online_participants ?? 0}
              hint={`${stats?.offline_participants ?? 0} offline`}
            />
            <Stat label="Total peserta" value={stats?.total_participants ?? 0} hint="Seluruh roster" />
            <Stat
              label="Insiden belum ditinjau"
              value={stats?.unreviewed_incidents ?? 0}
              hint={`${stats?.total_incidents ?? 0} insiden tercatat`}
            />
          </div>

          <section className="card">
            <div className="card-header">
              <div>
                <h2>Ujian berlangsung</h2>
                <p>Sesi dengan timer server yang sedang berjalan.</p>
              </div>
              <Link to="/monitoring" className="btn btn-secondary btn-sm">
                Buka pemantauan
              </Link>
            </div>

            {live.length === 0 ? (
              <EmptyState
                title="Belum ada ujian yang berlangsung"
                description="Mulai ujian dari halaman detail ujian untuk mengaktifkan pemantauan."
                action={
                  <Link to="/exams" className="btn btn-ghost btn-sm">
                    Lihat daftar ujian
                  </Link>
                }
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Exam ID</th>
                      <th>Nama ujian</th>
                      <th>Status</th>
                      <th>Peserta</th>
                      <th>Insiden</th>
                      <th>Berakhir</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((exam) => (
                      <tr key={exam.id}>
                        <td className="mono">{exam.exam_code}</td>
                        <td>{exam.name}</td>
                        <td>
                          <ExamStatusBadge status={exam.status} />
                        </td>
                        <td className="mono">{exam.participant_count}</td>
                        <td className="mono">{exam.incident_count}</td>
                        <td className="small muted">{formatDateTime(exam.ends_at)}</td>
                        <td className="text-right">
                          <Link to={`/monitoring/${exam.id}`} className="btn btn-ghost btn-sm">
                            Pantau
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card mt-24">
            <div className="card-header">
              <div>
                <h2>Ujian terbaru</h2>
                <p>Termasuk ujian yang masih dalam persiapan.</p>
              </div>
            </div>
            {exams.length === 0 ? (
              <EmptyState
                title="Belum ada ujian"
                description="Buat ujian pertama untuk mulai mengelola peserta."
                action={
                  <Link to="/exams" className="btn btn-primary btn-sm">
                    Buat ujian
                  </Link>
                }
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Exam ID</th>
                      <th>Nama</th>
                      <th>Status</th>
                      <th>Durasi</th>
                      <th>Peserta</th>
                      <th>Proktor</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {exams.slice(0, 6).map((exam) => (
                      <tr key={exam.id}>
                        <td className="mono">{exam.exam_code}</td>
                        <td>{exam.name}</td>
                        <td>
                          <ExamStatusBadge status={exam.status} />
                        </td>
                        <td className="mono">{exam.duration_minutes} mnt</td>
                        <td className="mono">{exam.participant_count}</td>
                        <td className="mono">{exam.proctor_count}</td>
                        <td className="text-right">
                          <Link to={`/exams/${exam.id}`} className="btn btn-ghost btn-sm">
                            Detail
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
