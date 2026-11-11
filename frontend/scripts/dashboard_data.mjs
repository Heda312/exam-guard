/**
 * Deeper dashboard smoke: creates an exam, opens its detail + monitoring pages,
 * and deletes it again. Catches crashes that only happen with real data.
 *
 * Usage: node scripts/dashboard_data.mjs http://127.0.0.1:5173 heda WedhusGembel5
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
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 950 });

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("#username");
await page.type("#username", USERNAME);
await page.type("#password", PASSWORD);
await Promise.all([
  page.waitForFunction(() => !window.location.pathname.startsWith("/login"), { timeout: 20000 }),
  page.click('button[type="submit"]'),
]);
check("login berhasil", !page.url().includes("/login"));

// Create an exam through the API from inside the page (cookie + CSRF already set).
const exam = await page.evaluate(async () => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  const response = await fetch("/api/v1/exams", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({
      name: "Ujian Navigasi",
      duration_minutes: 45,
      status: "REGISTRATION_OPEN",
      google_forms_url: "https://docs.google.com/forms/d/e/nav-smoke/viewform",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
});
check("ujian dibuat lewat API", Boolean(exam?.id), exam?.exam_code ?? "");

async function visit(path, label) {
  const before = errors.length;
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
  await sleep(1200);
  const text = await page.evaluate(() => document.body.innerText.trim());
  const rootChildren = await page.evaluate(
    () => document.getElementById("root")?.children.length ?? 0,
  );
  const newErrors = errors.slice(before);
  const ok = text.length > 40 && rootChildren > 0 && newErrors.length === 0;
  check(label, ok, ok ? "" : `text=${text.slice(0, 80)} err=${newErrors.join(" | ").slice(0, 160)}`);
  return text;
}

await visit(`/exams/${exam.id}`, "halaman detail ujian memuat");
await visit(`/monitoring/${exam.id}`, "halaman pemantauan ujian memuat");
await visit("/monitoring", "halaman pemantauan tanpa pilihan memuat");

// Tab switching inside the detail page.
await page.goto(`${BASE}/exams/${exam.id}`, { waitUntil: "networkidle2" });
await sleep(800);
for (const label of ["Proktor & izin", "Pengaturan", "Roster peserta"]) {
  const clicked = await page.evaluate((target) => {
    const button = [...document.querySelectorAll("button[role=tab]")].find(
      (element) => element.textContent?.trim() === target,
    );
    if (button) button.click();
    return Boolean(button);
  }, label);
  await sleep(700);
  const text = await page.evaluate(() => document.body.innerText.trim());
  check(`tab "${label}" dapat dibuka`, clicked && text.length > 40);
}

// Delete the exam from the UI (admin) and confirm we land back on /exams.
errors.length = 0;
await page.evaluate(() => {
  window.confirm = () => true;
});
const deleteClicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Hapus ujian",
  );
  if (button) button.click();
  return Boolean(button);
});
await sleep(1800);
check("tombol Hapus ujian tersedia", deleteClicked);
const afterDelete = await page.evaluate(() => ({
  path: window.location.pathname,
  text: document.body.innerText.trim().slice(0, 120),
}));
check(
  "kembali ke daftar ujian setelah dihapus",
  afterDelete.path === "/exams" && afterDelete.text.length > 20,
  `${afterDelete.path} :: ${afterDelete.text.slice(0, 60)}`,
);
check("tidak ada error konsol", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
