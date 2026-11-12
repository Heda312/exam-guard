/**
 * Late-arrival flow:
 *
 *  1. the exam is already LIVE
 *  2. a participant registers afterwards (must succeed, not "Ujian sudah dimulai")
 *  3. the "Buka ujian" button works end to end (ready -> monitoring start)
 *  4. the proctor dashboard shows the "Terlambat" flag on the card
 *
 * Usage: node scripts/late_join_e2e.mjs http://127.0.0.1:5173
 */
import puppeteer from "puppeteer-core";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const EXT_DIR = path.resolve("..", "extension");
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/abisu/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "heda";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "WedhusGembel5";
const EXAM_URL = "https://docs.google.com/forms/d/e/late-join/viewform";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(label, ok, extra = "") {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
}

async function waitFor(probe, timeoutMs = 20000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* retry */
    }
    await sleep(intervalMs);
  }
  return null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});

async function findWorker() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const target = browser
      .targets()
      .find((item) => item.type() === "service_worker" && item.url().startsWith("chrome-extension://"));
    if (target) return { target, worker: await target.worker() };
    await sleep(300);
  }
  throw new Error("extension service worker not found");
}
await findWorker();

/* --------------------------- Admin: exam goes LIVE first -------------------- */
const admin = await browser.newPage();
await admin.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await admin.waitForSelector("#username", { timeout: 20000 });
await admin.type("#username", ADMIN_USERNAME);
await admin.type("#password", ADMIN_PASSWORD);
await admin.click('button[type="submit"]');
await admin.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 20000 });

const exam = await admin.evaluate(async (examUrl) => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
  const code = `EXG-LATE-${String(Date.now()).slice(-6)}`;
  const response = await fetch("/api/v1/exams", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Ujian Telat",
      exam_code: code,
      duration_minutes: 30,
      status: "REGISTRATION_OPEN",
      google_forms_url: examUrl,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const created = await response.json();
  await fetch(`/api/v1/exams/${created.id}/roster`, {
    method: "POST",
    headers,
    body: JSON.stringify({ full_name: "Peserta Telat", npm: "20218888" }),
  });
  // Start the exam BEFORE anyone registers.
  await fetch(`/api/v1/exams/${created.id}/start`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  });
  return created;
}, EXAM_URL);
check("ujian sudah LIVE sebelum peserta mendaftar", Boolean(exam?.id), exam?.exam_code ?? "");

// Wait past the late-join grace window (LATE_JOIN_GRACE_SECONDS, default 60 s)
// so this participant is genuinely late rather than "registered around start".
const graceSeconds = Number(process.env.LATE_JOIN_GRACE_SECONDS ?? 60);
if (graceSeconds > 0) {
  console.log(`waiting ${graceSeconds + 3}s to exceed the late-join grace window...`);
  await sleep((graceSeconds + 3) * 1000);
}

/* ------------------------- Participant arrives late ------------------------- */
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto(`${BASE}/join/${exam.exam_code}`, { waitUntil: "networkidle2" });
await page.waitForSelector("#full_name", { timeout: 15000 });
await page.type("#full_name", "Peserta Telat");
await page.type("#npm", "20218888");
await page.click('input[type="checkbox"]');
await page.click('button[type="submit"]');
await sleep(3500);

const afterRegister = await page.evaluate(() => ({
  text: document.body.innerText,
  hasEndModal: Boolean(document.getElementById("exam_end_title")),
  buttons: [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()),
}));

check(
  "peserta telat TIDAK ditolak",
  !afterRegister.text.includes("Ujian sudah dimulai"),
  afterRegister.text.includes("Ujian sudah dimulai") ? "masih ditolak" : "diterima",
);
check("tidak ada popup ujian berakhir", !afterRegister.hasEndModal);
check(
  "tombol 'Buka ujian' tersedia",
  afterRegister.buttons.includes("Buka ujian"),
  afterRegister.buttons.join(" | ").slice(0, 120),
);

/* ------------------- Click it: ready + monitoring must succeed -------------- */
const clicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Buka ujian",
  );
  if (button) button.click();
  return Boolean(button);
});
check("tombol 'Buka ujian' bisa diklik", clicked);
await sleep(14000);

const state = await waitFor(async () => {
  const payload = await admin.evaluate(async (examId) => {
    const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
    return response.json();
  }, exam.id);
  return payload.cards?.[0]?.status === "MONITORING" ? payload : null;
}, 25000);

check(
  "peserta telat berhasil masuk MONITORING",
  Boolean(state),
  state?.cards?.[0]?.status ?? "belum",
);
check(
  "card menandai peserta sebagai TERLAMBAT",
  state?.cards?.[0]?.is_late === true,
  String(state?.cards?.[0]?.is_late),
);

/* ----------------------------- Flag visible in UI --------------------------- */
await admin.goto(`${BASE}/monitoring/${exam.id}`, { waitUntil: "networkidle2" });
await admin.waitForSelector(".participant-card", { timeout: 20000 });
await sleep(1500);
const cardText = await admin.evaluate(
  () => document.querySelector(".participant-card")?.innerText ?? "",
);
check(
  "badge 'Terlambat' tampil di kartu peserta",
  cardText.includes("Terlambat"),
  cardText.slice(0, 90).replace(/\n/g, " "),
);

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
