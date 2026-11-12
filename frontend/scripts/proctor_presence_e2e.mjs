/**
 * Two staff accounts watch the same LIVE exam from separate browser contexts;
 * each "Proktor live" widget must list both names, and drop one when it leaves.
 *
 * Usage: node scripts/proctor_presence_e2e.mjs http://127.0.0.1:5173
 */
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/abisu/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "heda";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "WedhusGembel5";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(label, ok, extra = "") {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
}

async function waitFor(probe, timeoutMs = 15000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function login(page, username, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#username", { timeout: 20000 });
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 20000 });
}

const widgetText = (page) =>
  page.evaluate(() => document.querySelector(".proctor-float")?.textContent ?? "");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* --------------------- Admin: exam + proctor fixtures ---------------------- */
const adminContext = await browser.createBrowserContext();
const admin = await adminContext.newPage();
await admin.setViewport({ width: 1440, height: 1000 });
await login(admin, ADMIN_USERNAME, ADMIN_PASSWORD);

const stamp = String(Date.now()).slice(-6);
const proctorUsername = `presence${stamp}`;
const proctorPassword = "PresenceTest123";
const proctorName = `Proktor Presence ${stamp}`;

const fixture = await admin.evaluate(
  async ({ stamp, proctorUsername, proctorPassword, proctorName }) => {
    const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
    const post = async (path, body) => {
      const response = await fetch(`/api/v1${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
      return response.json();
    };
    const me = await (await fetch("/api/v1/auth/me")).json();
    const exam = await post("/exams", {
      name: "Ujian Presence",
      exam_code: `EXG-PRS-${stamp}`,
      duration_minutes: 30,
      status: "REGISTRATION_OPEN",
      google_forms_url: "https://docs.google.com/forms/d/e/presence/viewform",
    });
    const proctor = await post("/admin/proctors", {
      username: proctorUsername,
      full_name: proctorName,
      password: proctorPassword,
    });
    await post(`/admin/exams/${exam.id}/proctors`, {
      proctor_user_id: proctor.id,
      permissions: { can_view_exam: true, can_view_participants: true, can_review_incidents: true },
    });
    await post(`/exams/${exam.id}/start`);
    return { examId: exam.id, adminName: me.user?.full_name ?? me.full_name };
  },
  { stamp, proctorUsername, proctorPassword, proctorName },
);
check("fixture ujian LIVE + proktor ditugaskan", Boolean(fixture.examId), fixture.adminName);

/* ------------------------ Both open the monitoring page -------------------- */
await admin.goto(`${BASE}/monitoring/${fixture.examId}`, { waitUntil: "networkidle2" });

const proctorContext = await browser.createBrowserContext();
const proctor = await proctorContext.newPage();
await proctor.setViewport({ width: 1440, height: 1000 });
await login(proctor, proctorUsername, proctorPassword);
await proctor.goto(`${BASE}/monitoring/${fixture.examId}`, { waitUntil: "networkidle2" });

const bothOnAdmin = await waitFor(async () => {
  const text = await widgetText(admin);
  return text.includes(fixture.adminName) && text.includes(proctorName) ? text : null;
});
check("widget admin menampilkan admin + proktor", Boolean(bothOnAdmin), bothOnAdmin ?? (await widgetText(admin)));

const bothOnProctor = await waitFor(async () => {
  const text = await widgetText(proctor);
  return text.includes(fixture.adminName) && text.includes(proctorName) ? text : null;
});
check(
  "widget proktor menampilkan admin + proktor",
  Boolean(bothOnProctor),
  bothOnProctor ?? (await widgetText(proctor)),
);

/* ------------------------------ Proctor leaves ----------------------------- */
await proctor.close();
const adminAlone = await waitFor(async () => {
  const text = await widgetText(admin);
  return text.includes(fixture.adminName) && !text.includes(proctorName) ? text : null;
});
check("proktor keluar → hilang dari widget admin", Boolean(adminAlone), adminAlone ?? (await widgetText(admin)));

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
