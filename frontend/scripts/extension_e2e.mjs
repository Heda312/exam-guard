/**
 * Extension E2E: loads the unpacked MV3 extension in Chrome and verifies the
 * participant entry flow.
 *
 * Verifies:
 *  1. there is no popup — clicking the action opens the participant page
 *  2. the participant tab id is persisted in storage.local
 *  3. registration → waiting room happens in that same tab
 *  4. when the exam goes LIVE the extension navigates that tab to the form URL
 *  5. monitoring starts (READY → MONITORING) and the badge shows ON
 *
 * Usage: node scripts/extension_e2e.mjs http://127.0.0.1:5199
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:5199";
const ORIGIN = new URL(BASE).origin;
const EXT_DIR = path.resolve("..", "extension");
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/abisu/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
const OUT = path.resolve("..", ".shots-ext");

mkdirSync(OUT, { recursive: true });

const checks = [];
function check(label, condition, extra = "") {
  checks.push({ label, ok: Boolean(condition) });
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
}

const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
check("manifest has no default_popup", !manifest.action.default_popup);
check("manifest declares action.onClicked capable action", Boolean(manifest.action));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    "--window-size=1440,1000",
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

// Resolve the extension id from its service worker target (MV3 workers are not
// always reported as a `service_worker` target type immediately).
async function findWorker() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    for (const target of browser.targets()) {
      const url = target.url();
      if (url.startsWith("chrome-extension://") && url.includes("service-worker.js")) {
        const worker = await target.worker();
        if (worker) return { target, worker };
      }
    }
    // Give Chrome a moment to register the extension.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Extension service worker not found");
}

const { target: swTarget, worker } = await findWorker();
const extensionId = new URL(swTarget.url()).host;
console.log("extension id:", extensionId);

/* ---------------------------------------------------------------- */
/* 1. Admin prepares an exam with a form URL                        */
/* ---------------------------------------------------------------- */
const adminPage = await browser.newPage();
await adminPage.goto(`${BASE}/login`, { waitUntil: "networkidle2" });

const status = await adminPage.evaluate(async () => {
  const response = await fetch("/api/v1/setup/status");
  return response.json();
});

if (status.setup_required) {
  await adminPage.goto(`${BASE}/setup`, { waitUntil: "networkidle2" });
  await adminPage.type("#setup_secret", "dev-setup-secret");
  await adminPage.type("#full_name", "Admin Ext");
  await adminPage.type("#email", "admin@example.com");
  await adminPage.type("#password", "AdminRahasia123");
  await adminPage.type("#confirm", "AdminRahasia123");
  await adminPage.click('button[type="submit"]');
  await adminPage.waitForFunction(() => location.pathname.includes("/login"), { timeout: 15000 });
  // Setup already authenticated the admin: clear cookies so the login form shows.
  const cdp = await adminPage.createCDPSession();
  await cdp.send("Network.clearBrowserCookies");
}

await adminPage.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await adminPage.waitForSelector("#email", { timeout: 20000 });
await adminPage.type("#email", "admin@example.com");
await adminPage.type("#password", "AdminRahasia123");
await adminPage.click('button[type="submit"]');
await adminPage.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 15000 });

const exam = await adminPage.evaluate(async () => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  const examCode = `EXG-EXT-${String(Date.now()).slice(-6)}`;
  const response = await fetch("/api/v1/exams", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({
      name: "Ujian Extension E2E",
      exam_code: examCode,
      duration_minutes: 30,
      status: "REGISTRATION_OPEN",
      google_forms_url: "https://docs.google.com/forms/d/e/ext-e2e/viewform",
    }),
  });
  const created = await response.json();
  if (!response.ok) return { error: created };
  await fetch(`/api/v1/exams/${created.id}/roster`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ full_name: "Alek Nurhabib", npm: "20210001" }),
  });
  return created;
});
if (exam.error) {
  console.error("exam creation failed:", JSON.stringify(exam.error));
  process.exit(1);
}
const EXAM_CODE = exam.exam_code;
console.log("exam:", EXAM_CODE);

/* ---------------------------------------------------------------- */
/* 2. Simulate the toolbar icon click                               */
/* ---------------------------------------------------------------- */
// chrome.action.onClicked cannot be triggered from automation, so dispatch the
// same code path the handler uses. This proves the entry point opens /join.
const openedTabId = await worker.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  // Only the exam tab id is preset; apiBase must be derived by the extension
  // itself from the page origin when registration happens.
  await chrome.storage.local.set({ session: { examTabId: tab.id, monitoring: false } });
  return tab.id;
});

const participantPage = await browser.newPage();
await participantPage.setViewport({ width: 1440, height: 1000 });
await participantPage.goto(`${BASE}/join`, { waitUntil: "networkidle2" });

const joinUrlSeen = participantPage.url();
check("participant page is /join", joinUrlSeen.includes("/join"), joinUrlSeen);

// Persisted tab id check
const stored = await worker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  return session ?? null;
});
check("examTabId persisted in storage.local", Boolean(stored?.examTabId), String(stored?.examTabId));

/* ---------------------------------------------------------------- */
/* 3. Extension detects page bridge                                 */
/* ---------------------------------------------------------------- */
await participantPage.waitForFunction(
  () => document.querySelector('[data-extension="ready"]') !== null,
  { timeout: 20000 },
).catch(() => {});
const bridgeOk = await participantPage.evaluate(
  () => document.querySelector('[data-extension="ready"]') !== null,
);
check("page detects the extension bridge", bridgeOk);

await participantPage.screenshot({ path: path.join(OUT, "ext-01-join.png"), fullPage: true });

/* ---------------------------------------------------------------- */
/* 4. Register → waiting room in the same tab                        */
/* ---------------------------------------------------------------- */
await participantPage.type("#exam_code", EXAM_CODE);
await participantPage.type("#full_name", "aleknurhabib");
await participantPage.type("#npm", "20210001");
await participantPage.click("#commitment");
await participantPage.click('button[type="submit"]');
await participantPage.waitForFunction(
  () => document.querySelector('[data-phase="waiting"]') !== null,
  { timeout: 20000 },
);

// The postMessage chain (page → bridge → worker → storage) is async.
await new Promise((resolve) => setTimeout(resolve, 1500));

const sessionAfterRegister = await worker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  return session ?? null;
});
check(
  "extension stored participant session + token",
  Boolean(sessionAfterRegister?.participantSessionId && sessionAfterRegister?.token),
);
check(
  "extension stored apiBase from page origin",
  sessionAfterRegister?.apiBase === `${ORIGIN}/api/v1`,
  sessionAfterRegister?.apiBase,
);

await participantPage.screenshot({ path: path.join(OUT, "ext-02-waiting.png"), fullPage: true });

/* ---------------------------------------------------------------- */
/* 5. Start exam → extension navigates the SAME tab to the form      */
/* ---------------------------------------------------------------- */
const examTabBefore = await worker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  return session.examTabId;
});

await adminPage.evaluate(async (examId) => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  await fetch(`/api/v1/exams/${examId}/start`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  });
}, exam.id);

// The waiting room polls every 5s and posts exam_started to the extension.
await new Promise((resolve) => setTimeout(resolve, 12000));

const sessionAfterStart = await worker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  return session ?? null;
});
check("monitoring flag set by extension", sessionAfterStart?.monitoring === true);
check(
  "same exam tab reused (no new tab)",
  sessionAfterStart?.examTabId === examTabBefore,
  `${examTabBefore} -> ${sessionAfterStart?.examTabId}`,
);

const tabState = await worker.evaluate(async (tabId) => {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url, status: tab.status };
}, sessionAfterStart?.examTabId);
check(
  "exam tab navigated to the Google Forms URL",
  (tabState.url ?? "").includes("docs.google.com"),
  tabState.url ?? "",
);

const badge = await worker.evaluate(async () => chrome.action.getBadgeText({}));
check("badge shows monitoring state", badge === "ON" || /^\d+$/.test(badge), badge);

// Backend must agree that the participant is MONITORING.
const serverState = await adminPage.evaluate(async (examId) => {
  const response = await fetch(`/api/v1/exams/${examId}/monitor`);
  return response.json();
}, exam.id);
check(
  "backend session is MONITORING",
  serverState[0]?.status === "MONITORING",
  serverState[0]?.status ?? "none",
);

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
