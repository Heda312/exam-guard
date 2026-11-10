/**
 * UI screenshot walker: drives the real app with Chrome via puppeteer-core.
 *
 * Usage: node scripts/ui_shots.mjs http://127.0.0.1:5199
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:5199";
const OUT = "D:/my_project/exam-guard/.shots/";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

mkdirSync(OUT, { recursive: true });

const shots = [];
async function shot(page, name) {
  const path = `${OUT}${name}.png`;
  await page.screenshot({ path, fullPage: true });
  shots.push(name);
  console.log("shot:", name);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1440,1000"],
  defaultViewport: { width: 1440, height: 1000 },
});

const page = await browser.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("PAGE ERROR:", msg.text());
});
page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));

const SETUP_SECRET = "dev-setup-secret";
const ADMIN = { email: "admin@example.com", password: "AdminRahasia123" };

// 1. Setup page
await page.goto(`${BASE}/setup`, { waitUntil: "networkidle2" });
await shot(page, "01-setup");

// Complete setup if required
const status = await page.evaluate(async () => {
  const response = await fetch("/api/v1/setup/status");
  return response.json();
});

if (status.setup_required) {
  await page.type("#setup_secret", SETUP_SECRET);
  await page.type("#full_name", "Admin Utama");
  await page.type("#email", ADMIN.email);
  await page.type("#password", ADMIN.password);
  await page.type("#confirm", ADMIN.password);
  await page.click('button[type="submit"]');
  await page
    .waitForFunction(() => location.pathname.includes("/login"), { timeout: 15000 })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

// 2. Login (clear cookies first so /login is not redirected away)
const client = await page.createCDPSession();
await client.send("Network.clearBrowserCookies");
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.evaluate(() => localStorage.clear());
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("#email", { timeout: 15000 });
await shot(page, "02-login");
await page.type("#email", ADMIN.email);
await page.type("#password", ADMIN.password);
await page.click('button[type="submit"]');
await page.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 15000 });
await new Promise((resolve) => setTimeout(resolve, 1200));
await shot(page, "03-dashboard-empty");

// 3. Create exam via API (faster and deterministic), then reload dashboard
const exam = await page.evaluate(async () => {
  const csrf = document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "";
  const response = await fetch("/api/v1/exams", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) },
    body: JSON.stringify({
      name: "Ujian Tengah Semester — Algoritma",
      exam_code: "EXG-2026-001",
      description: "Ujian tengah semester mata kuliah Algoritma dan Struktur Data.",
      duration_minutes: 90,
      status: "REGISTRATION_OPEN",
      google_forms_url: "https://docs.google.com/forms/d/e/1FAIpQLSdemo/viewform",
    }),
  });
  return response.json();
});
console.log("exam:", exam.exam_code, exam.id);

await page.evaluate(async (examId) => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  const roster = [
    ["Alek Nurhabib", "20210001", "Informatika A"],
    ["Siti Aminah", "20210002", "Informatika A"],
    ["Budi Santoso", "20210003", "Informatika B"],
    ["Dewi Lestari", "20210004", "Informatika B"],
    ["Rizky Pratama", "20210005", "Informatika A"],
  ];
  for (const [full_name, npm, group_name] of roster) {
    await fetch(`/api/v1/exams/${examId}/roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ full_name, npm, group_name }),
    });
  }
}, exam.id);

// 4. Exams list
await page.goto(`${BASE}/exams`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 900));
await shot(page, "04-exams");

// 5. Exam detail (roster tab)
await page.goto(`${BASE}/exams/${exam.id}`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 1200));
await shot(page, "05-exam-detail-roster");

// 6. Proctor tab
const proctorButtons = await page.$$('button[role="tab"]');
if (proctorButtons[1]) {
  await proctorButtons[1].click();
  await new Promise((resolve) => setTimeout(resolve, 700));
  await shot(page, "06-exam-detail-proctors");
}
if (proctorButtons[2]) {
  await proctorButtons[2].click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await shot(page, "07-exam-detail-settings");
}

// 7. Participant registration flow in a separate incognito context
const participantContext = await browser.createBrowserContext();
const participantPage = await participantContext.newPage();
await participantPage.setViewport({ width: 1440, height: 1000 });
participantPage.on("pageerror", (err) => console.log("PARTICIPANT EXCEPTION:", err.message));

await participantPage.goto(`${BASE}/join`, { waitUntil: "networkidle2" });
await shot(participantPage, "08-participant-form");

await participantPage.type("#exam_code", "EXG-2026-001");
await participantPage.type("#full_name", "aleknurhabib");
await participantPage.type("#npm", "20210001");
await participantPage.click("#commitment");
await new Promise((resolve) => setTimeout(resolve, 600));
await shot(participantPage, "09-participant-filled");

await participantPage.click('button[type="submit"]');
await participantPage
  .waitForFunction(() => document.body.innerText.includes("Identitas terverifikasi"), { timeout: 15000 })
  .catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 900));
await shot(participantPage, "10-participant-waiting");

// 8. Start exam from the dashboard, then look at monitoring + participant exam view
await page.goto(`${BASE}/exams/${exam.id}`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 900));
const startButton = await page.$$eval("button", (buttons) =>
  buttons.findIndex((button) => button.textContent?.includes("Mulai ujian")),
);
if (startButton >= 0) {
  const buttons = await page.$$("button");
  await buttons[startButton].click();
  await new Promise((resolve) => setTimeout(resolve, 1800));
}

await participantPage.reload({ waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 1200));
await shot(participantPage, "11-participant-exam");

await page.goto(`${BASE}/monitoring/${exam.id}`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 2000));
await shot(page, "12-monitoring");

// 9. Push monitoring events through the participant API so incidents appear
const sessionState = await participantPage.evaluate(async () => {
  const id = localStorage.getItem("examguard.participant.session");
  const token = localStorage.getItem("examguard.participant.token");
  if (!id || !token) return null;
  const headers = { "Content-Type": "application/json", "X-Participant-Token": token };
  await fetch("/api/v1/participant/ready", {
    method: "POST",
    headers,
    body: JSON.stringify({ participant_session_id: id }),
  });
  await fetch("/api/v1/participant/monitoring/start", {
    method: "POST",
    headers,
    body: JSON.stringify({ participant_session_id: id }),
  });
  await fetch(`/api/v1/participant/events?participant_session_id=${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify([
      { client_event_id: "ui-1", event_type: "TAB_SWITCH", page_url: "https://docs.google.com/forms/d/e/x/viewform" },
      { client_event_id: "ui-2", event_type: "NEW_TAB", page_url: "https://www.google.com/search?q=jawaban" },
      { client_event_id: "ui-3", event_type: "FOCUS_LOST" },
    ]),
  });
  return { id };
});
console.log("participant session:", sessionState?.id ?? "none");

await new Promise((resolve) => setTimeout(resolve, 1500));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 2500));
await shot(page, "13-monitoring-incidents");

// 10. Participant detail modal
const detailButtons = await page.$$eval("button", (buttons) =>
  buttons.map((button, index) => (button.textContent?.includes("Lihat detail") ? index : -1)).filter((i) => i >= 0),
);
if (detailButtons.length > 0) {
  const buttons = await page.$$("button");
  await buttons[detailButtons[0]].click();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await shot(page, "14-participant-detail");
}

// 11. Proctors + audit pages
await page.goto(`${BASE}/proctors`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 800));
await shot(page, "15-proctors");

await page.goto(`${BASE}/audit`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 800));
await shot(page, "16-audit");

// 12. Mobile viewport
await page.setViewport({ width: 430, height: 932 });
await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
await new Promise((resolve) => setTimeout(resolve, 1000));
await shot(page, "17-mobile-dashboard");

await browser.close();
console.log("\nScreenshots:", shots.length, "->", OUT);
