/**
 * Dashboard navigation smoke test: logs in as admin and walks every page,
 * asserting the app does not crash (no error boundary / blank root).
 *
 * Usage: node scripts/dashboard_nav.mjs http://127.0.0.1:5173 heda WedhusGembel5
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
await page.setViewport({ width: 1400, height: 900 });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("#username", { timeout: 15000 });
await page.type("#username", USERNAME);
await page.type("#password", PASSWORD);
await Promise.all([
  page.waitForFunction(() => !window.location.pathname.startsWith("/login"), { timeout: 20000 }),
  page.click('button[type="submit"]'),
]);
check("login dengan username berhasil", !page.url().includes("/login"), page.url());

/** Visit a route and make sure the shell rendered content, not a blank page. */
async function visit(path, label, waitFor) {
  const before = consoleErrors.length;
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
  await sleep(1200);
  const text = await page.evaluate(() => document.body.innerText.trim());
  const rootChildren = await page.evaluate(
    () => document.getElementById("root")?.children.length ?? 0,
  );
  const newErrors = consoleErrors.slice(before);
  const ok = text.length > 40 && rootChildren > 0 && newErrors.length === 0;
  check(label, ok, ok ? "" : `text=${text.slice(0, 60)} errors=${newErrors.join(" | ").slice(0, 200)}`);
  if (waitFor) {
    const found = await page
      .waitForSelector(waitFor, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check(`${label} — elemen ${waitFor} muncul`, found);
  }
  return text;
}

await visit("/", "halaman Ringkasan memuat");
await visit("/exams", "halaman Ujian memuat");
await visit("/monitoring", "halaman Pemantauan memuat");
await visit("/proctors", "halaman Proktor memuat", "#proctor_username");
await visit("/audit", "halaman Audit memuat");

// Client-side navigation between pages (the reported crash was on page change).
consoleErrors.length = 0;
await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
const navLinks = [
  ["/exams", "Ujian"],
  ["/monitoring", "Pemantauan"],
  ["/proctors", "Proktor"],
  ["/audit", "Audit"],
  ["/", "Ringkasan"],
];
for (const [path, label] of navLinks) {
  await page.evaluate((target) => {
    const link = [...document.querySelectorAll("a")].find(
      (element) => element.getAttribute("href") === target,
    );
    if (link) link.click();
  }, path);
  await sleep(1000);
  const text = await page.evaluate(() => document.body.innerText.trim());
  const rootChildren = await page.evaluate(
    () => document.getElementById("root")?.children.length ?? 0,
  );
  const ok = text.length > 40 && rootChildren > 0;
  check(`navigasi SPA ke ${label}`, ok, ok ? "" : text.slice(0, 80));
}
check(
  "tidak ada error konsol selama navigasi",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(" | "),
);

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
