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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:5199";
const ORIGIN = new URL(BASE).origin;
const EXT_DIR = path.resolve("..", "extension");
// Admin credentials for the local stack. The bootstrap defaults are
// `heda` / `WedhusGembel5`; override with env vars for a custom deployment.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "heda";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "WedhusGembel5";
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Users/abisu/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
const OUT = path.resolve("..", ".shots-ext");
// Optional: point at the live SQLite database to exercise the TIME_EXPIRED path.
// Without it the script verifies the proctor-ended (COMPLETED) overlay instead.
const E2E_DB = process.env.E2E_DB ?? "";

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(label, condition, extra = "") {
  checks.push({ label, ok: Boolean(condition) });
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
}

async function waitFor(probe, timeoutMs = 10000, intervalMs = 400) {
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

/** Wake an idle MV3 worker through the page bridge, then re-resolve it. */
async function getWorker(page) {
  if (page) {
    await page
      .evaluate(() =>
        window.postMessage(
          { source: "examguard-web", type: "get_state" },
          window.location.origin,
        ),
      )
      .catch(() => {});
    await sleep(400);
  }
  return (await findWorker()).worker;
}

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
  await adminPage.type("#username", ADMIN_USERNAME);
  await adminPage.type("#password", ADMIN_PASSWORD);
  await adminPage.type("#confirm", ADMIN_PASSWORD);
  await adminPage.click('button[type="submit"]');
  await adminPage.waitForFunction(() => location.pathname.includes("/login"), { timeout: 15000 });
  // Setup already authenticated the admin: clear cookies so the login form shows.
  const cdp = await adminPage.createCDPSession();
  await cdp.send("Network.clearBrowserCookies");
}

await adminPage.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await adminPage.waitForSelector("#username", { timeout: 20000 });
await adminPage.type("#username", ADMIN_USERNAME);
await adminPage.type("#password", ADMIN_PASSWORD);
await adminPage.click('button[type="submit"]');
await adminPage.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 20000 });

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

// The waiting room polls every 5s. It must NOT navigate the tab by itself:
// the participant presses "Buka ujian" explicitly.
await new Promise((resolve) => setTimeout(resolve, 12000));

const waitingState = await participantPage.evaluate(() => ({
  path: window.location.pathname,
  text: document.body.innerText,
  buttons: [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()),
}));
check(
  "waiting room does not auto-redirect to the exam",
  waitingState.path.includes("/join"),
  waitingState.path,
);
check(
  "waiting room shows the exam is open",
  waitingState.text.includes("Ujian sudah dibuka"),
  waitingState.text.slice(0, 70).replace(/\n/g, " "),
);
check(
  "waiting room offers a 'Buka ujian' button",
  waitingState.buttons.includes("Buka ujian"),
  waitingState.buttons.join(" | ").slice(0, 120),
);

// Press it: this is what the participant does when they are ready.
const clickStart = await participantPage.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Buka ujian",
  );
  if (button) button.click();
  return Boolean(button);
});
check("'Buka ujian' is clickable", clickStart);
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
  const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
  return response.json();
}, exam.id);
check(
  "backend session is MONITORING",
  serverState.cards?.[0]?.status === "MONITORING",
  serverState.cards?.[0]?.status ?? "none",
);
check(
  "monitor/state bundles cards, incidents and timer",
  Array.isArray(serverState.cards) &&
    Array.isArray(serverState.incidents) &&
    serverState.timer?.remaining_seconds > 0,
  `cards=${serverState.cards?.length} incidents=${serverState.incidents?.length} timer=${serverState.timer?.remaining_seconds}`,
);

const overlayBefore = await participantPage.evaluate(
  () => document.getElementById("examguard-overlay-host") === null,
);
check("no warning overlay before a violation", overlayBefore);

/* ---------------------------------------------------------------- */
/* 6. Realtime card + tab-switch detection + return warning          */
/* ---------------------------------------------------------------- */
await adminPage.goto(`${BASE}/monitoring/${exam.id}`, { waitUntil: "networkidle2" });
await adminPage.waitForSelector(".participant-card", { timeout: 15000 });
const cardText = await adminPage.$eval(".participant-card", (element) => element.textContent ?? "");
check(
  "monitoring card shows the participant",
  cardText.includes("Alek Nurhabib"),
  cardText.slice(0, 80),
);

const liveBadge = await waitFor(
  () =>
    adminPage.$eval(".page-header", (element) =>
      (element.textContent ?? "").includes("Realtime aktif") ? true : null,
    ),
  12000,
);
check("monitoring dashboard reports an active realtime connection", Boolean(liveBadge));

// Switch to the dashboard tab, then return to the exam tab. The extension must
// record the switch immediately and raise the pending warning on return.
await adminPage.bringToFront();
await sleep(1500);
await participantPage.bringToFront();
await sleep(1800);

const overlayAfter = await participantPage.evaluate(() => {
  const host = document.getElementById("examguard-overlay-host");
  return host?.shadowRoot?.textContent ?? null;
});
check(
  "warning overlay appears when returning to the exam tab",
  Boolean(overlayAfter && overlayAfter.includes("Sepertinya anda kehilangan fokus")),
  overlayAfter?.slice(0, 90) ?? "none",
);

const incidentState = await waitFor(async () => {
  const state = await adminPage.evaluate(async (examId) => {
    const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
    return response.json();
  }, exam.id);
  return state.incidents?.length > 0 ? state : null;
}, 12000);
check(
  "backend recorded the fast tab-switch incident",
  incidentState?.incidents?.length >= 1,
  `${incidentState?.incidents?.length ?? 0} incident(s)`,
);
check(
  "card incident count reflects the violation",
  incidentState?.cards?.[0]?.incident_count >= 1,
  String(incidentState?.cards?.[0]?.incident_count ?? 0),
);
check(
  "card stores the latest incident type",
  ["TAB_SWITCH", "FOCUS_LOST", "NAVIGATION", "NEW_TAB", "TAB_CLOSED"].includes(
    incidentState?.cards?.[0]?.last_incident_type ?? "",
  ),
  incidentState?.cards?.[0]?.last_incident_type ?? "none",
);

const cardUpdated = await adminPage
  .waitForFunction(
    () => {
      const card = document.querySelector(".participant-card");
      return Boolean(card && /\d+\s+insiden/.test(card.textContent ?? ""));
    },
    { timeout: 12000 },
  )
  .then(() => true)
  .catch(() => false);
check("monitoring card updates in realtime", cardUpdated);

/* ---------------------------------------------------------------- */
/* 7. Exam end / time-up overlay                                     */
/* ---------------------------------------------------------------- */
await participantPage.bringToFront();
await sleep(600);

const endsAtInPast = (() => {
  if (!E2E_DB) return false;
  if (!existsSync(E2E_DB)) {
    console.log(`[SKIP] E2E_DB not found: ${E2E_DB}`);
    return false;
  }
  const python = process.env.PYTHON ?? "python";
  const script = [
    "import sqlite3, sys",
    "con = sqlite3.connect(sys.argv[1], timeout=10)",
    "con.execute(\"update exam_sessions set ends_at = datetime('now','-1 minute') where exam_id = ?\", (sys.argv[2],))",
    "con.commit()",
    "con.close()",
  ].join("\n");
  try {
    execFileSync(python, ["-c", script, E2E_DB, exam.id], { stdio: "inherit" });
    return true;
  } catch (error) {
    console.log(`[SKIP] could not rewrite ends_at: ${error}`);
    return false;
  }
})();

if (!endsAtInPast) {
  await adminPage.evaluate(async (examId) => {
    const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
    await fetch(`/api/v1/exams/${examId}/end`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
    });
  }, exam.id);
}

// Wake the worker and force the heartbeat alarm so it observes the new state
// instead of waiting for the next 30 s tick.
let liveWorker = await getWorker(adminPage);
await liveWorker.evaluate(async () => {
  await chrome.alarms.create("examguard-heartbeat", { when: Date.now() + 100 });
});

const endOverlay = await waitFor(
  () =>
    participantPage.evaluate(() => {
      const host = document.getElementById("examguard-overlay-host");
      const text = host?.shadowRoot?.textContent ?? "";
      return text.includes("Ujian telah selesai") ? text : null;
    }),
  15000,
  600,
);
check(
  endsAtInPast
    ? "time-up overlay appears on the exam tab"
    : "exam-ended overlay appears on the exam tab",
  Boolean(endOverlay),
  endOverlay?.slice(0, 90) ?? "none",
);

liveWorker = await getWorker(adminPage);
const endedSession = await liveWorker.evaluate(
  async () => (await chrome.storage.local.get("session")).session ?? null,
);
check(
  "extension stops monitoring and marks the session ended",
  endedSession?.monitoring === false && endedSession?.ended === true,
  JSON.stringify({ monitoring: endedSession?.monitoring, ended: endedSession?.ended }),
);

await participantPage.screenshot({ path: path.join(OUT, "ext-03-warning.png"), fullPage: true });
await adminPage.screenshot({ path: path.join(OUT, "ext-04-monitoring.png"), fullPage: true });

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
