/**
 * Participant flow smoke: registers, verifies the waiting room does NOT show an
 * "exam ended" modal before the proctor starts, then verifies the explicit
 * "Buka ujian" button appears once the exam is live.
 *
 * Usage: node scripts/participant_flow.mjs http://127.0.0.1:5173 heda WedhusGembel5
 */
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const USERNAME = process.argv[3] ?? "heda";
const PASSWORD = process.argv[4] ?? "WedhusGembel5";
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/abisu/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(label, ok, extra = "") {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* ----------------------------- Admin side ----------------------------- */
const admin = await browser.newPage();
await admin.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await admin.waitForSelector("#username");
await admin.type("#username", USERNAME);
await admin.type("#password", PASSWORD);
await Promise.all([
  admin.waitForFunction(() => !window.location.pathname.startsWith("/login"), { timeout: 20000 }),
  admin.click('button[type="submit"]'),
]);

const setup = await admin.evaluate(async () => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
  const examResponse = await fetch("/api/v1/exams", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Ujian Alur Peserta",
      duration_minutes: 30,
      status: "REGISTRATION_OPEN",
      google_forms_url: "https://docs.google.com/forms/d/e/participant-flow/viewform",
    }),
  });
  if (!examResponse.ok) throw new Error(await examResponse.text());
  const exam = await examResponse.json();

  const rosterResponse = await fetch(`/api/v1/exams/${exam.id}/roster`, {
    method: "POST",
    headers,
    body: JSON.stringify({ full_name: "Peserta Uji", npm: "20219999" }),
  });
  if (!rosterResponse.ok) throw new Error(await rosterResponse.text());

  return { exam, csrf };
});
check("ujian + roster disiapkan", Boolean(setup.exam?.id), setup.exam?.exam_code ?? "");

/* --------------------------- Participant side -------------------------- */
const participant = await browser.newPage();
await participant.goto(`${BASE}/join/${setup.exam.exam_code}`, { waitUntil: "networkidle2" });
await participant.waitForSelector("#full_name", { timeout: 15000 });

// The Exam ID field is already pre-filled from the /join/:examCode route, so
// only the participant details need typing.
await participant.type("#full_name", "Peserta Uji");
await participant.type("#npm", "20219999");
await participant.click('input[type="checkbox"]');
await participant.click('button[type="submit"]');
await sleep(3000);

const afterRegister = await participant.evaluate(() => ({
  text: document.body.innerText,
  hasEndModal: Boolean(document.getElementById("exam_end_title")),
}));
check(
  "tidak ada popup 'ujian telah berakhir' setelah registrasi",
  !afterRegister.hasEndModal,
  afterRegister.hasEndModal ? "modal muncul prematur" : "",
);
check(
  "halaman menampilkan ruang tunggu",
  afterRegister.text.includes("Ruang tunggu") || afterRegister.text.includes("Ujian sudah dibuka"),
  afterRegister.text.slice(0, 80).replace(/\n/g, " "),
);

/* --------------------------- Exam goes live --------------------------- */
await admin.evaluate(async ({ examId, csrf }) => {
  await fetch(`/api/v1/exams/${examId}/start`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  });
}, { examId: setup.exam.id, csrf: setup.csrf });

// The waiting room polls every 5 s.
await sleep(7000);

const liveView = await participant.evaluate(() => ({
  text: document.body.innerText,
  hasEndModal: Boolean(document.getElementById("exam_end_title")),
  path: window.location.pathname,
  buttons: [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()),
}));
check(
  "peserta TIDAK otomatis dialihkan ke halaman ujian",
  liveView.path.includes("/join"),
  liveView.path,
);
check("tidak ada popup 'waktu habis' saat ujian baru dibuka", !liveView.hasEndModal);
check(
  "muncul pemberitahuan 'Ujian sudah dibuka'",
  liveView.text.includes("Ujian sudah dibuka"),
  liveView.text.slice(0, 90).replace(/\n/g, " "),
);
check(
  "tombol 'Buka ujian' tersedia",
  liveView.buttons.includes("Buka ujian"),
  liveView.buttons.join(" | ").slice(0, 120),
);

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
