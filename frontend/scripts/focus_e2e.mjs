/**
 * Verifies the focus/navigation fixes that were reported broken:
 *
 *  1. alt+tab on the exam tab is detected, creates a FOCUS_LOST incident and
 *     raises the red warning overlay when the participant returns
 *  2. the monitoring incident table shows the domain, not just the card
 *  3. moving between pages inside docs.google.com (multi-page form / Docs
 *     navigation) is NOT a violation, including same-URL page moves
 *  4. answering the form (clicking fields, Tab, radio, dropdowns) is NOT a
 *     violation
 *
 * The exam URL points at a local page that actually loads, because a Google
 * Forms URL cannot be fetched in this sandbox. The extension only cares about
 * the host, and the focus watcher is injected with chrome.scripting, so this
 * exercises the real code path.
 *
 * Usage: node scripts/focus_e2e.mjs http://127.0.0.1:5173
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

// Real Google Forms host: allow-listed and HTTPS, so backend validation accepts
// it. The specific form id does not exist, but the document still loads on
// docs.google.com, which is all the focus watcher needs.
const EXAM_URL = "https://docs.google.com/forms/d/e/focus-e2e/viewform";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(label, ok, extra = "") {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? ` — ${extra}` : ""}`);
}

async function waitFor(probe, timeoutMs = 15000, intervalMs = 500) {
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

// No local server needed: the exam tab points at docs.google.com.
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
    const targets = browser.targets();
    const target = targets.find(
      (item) => item.type() === "service_worker" && item.url().startsWith("chrome-extension://"),
    );
    if (target) return { target, worker: await target.worker() };
    await sleep(300);
  }
  throw new Error("extension service worker not found");
}

const { worker } = await findWorker();

/* -------------------------- Admin prepares the exam -------------------------- */
const adminPage = await browser.newPage();
await adminPage.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await adminPage.waitForSelector("#username", { timeout: 20000 });
await adminPage.type("#username", ADMIN_USERNAME);
await adminPage.type("#password", ADMIN_PASSWORD);
await adminPage.click('button[type="submit"]');
await adminPage.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 20000 });

const exam = await adminPage.evaluate(async (examUrl) => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
  const code = `EXG-FOC-${String(Date.now()).slice(-6)}`;
  const response = await fetch("/api/v1/exams", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Ujian Fokus",
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
    body: JSON.stringify({ full_name: "Peserta Fokus", npm: "20217777" }),
  });
  return created;
}, EXAM_URL);
check("ujian disiapkan", Boolean(exam?.id), exam?.exam_code ?? "");

/* --------------------------- Participant registers -------------------------- */
const participantPage = await browser.newPage();
await participantPage.setViewport({ width: 1440, height: 1000 });
await participantPage.goto(`${BASE}/join/${exam.exam_code}`, { waitUntil: "networkidle2" });
await participantPage.waitForSelector("#full_name", { timeout: 15000 });
await participantPage.type("#full_name", "Peserta Fokus");
await participantPage.type("#npm", "20217777");
await participantPage.click('input[type="checkbox"]');
await participantPage.click('button[type="submit"]');
await sleep(3000);

const registered = await participantPage.evaluate(() => ({
  text: document.body.innerText,
  hasEnd: Boolean(document.getElementById("exam_end_title")),
}));
check("registrasi berhasil", registered.text.includes("Identitas terverifikasi"), "");
check("tidak ada popup ujian berakhir", !registered.hasEnd);

/* ------------------------------- Exam goes live ----------------------------- */
await adminPage.evaluate(async (examId) => {
  const csrf = decodeURIComponent(document.cookie.match(/eg_csrf=([^;]*)/)?.[1] ?? "");
  await fetch(`/api/v1/exams/${examId}/start`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  });
}, exam.id);

await waitFor(
  () =>
    participantPage.evaluate(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Buka ujian",
      )
        ? true
        : null,
    ),
  15000,
);

await participantPage.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === "Buka ujian",
  );
  button?.click();
});
await sleep(14000);

const monitoring = await waitFor(async () => {
  const state = await adminPage.evaluate(async (examId) => {
    const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
    return response.json();
  }, exam.id);
  return state.cards?.[0]?.status === "MONITORING" ? state : null;
}, 20000);
check("peserta MONITORING", Boolean(monitoring), monitoring?.cards?.[0]?.status ?? "none");

const incidentCount = async () =>
  adminPage.evaluate(async (examId) => {
    const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
    const state = await response.json();
    return state.incidents?.length ?? 0;
  }, exam.id);

const pendingWarning = async () => {
  const { worker: current } = await findWorker();
  return current.evaluate(async () => {
    const { session } = await chrome.storage.local.get("session");
    return session?.pendingWarning ?? null;
  });
};

/* ------------- Answering the form: clicks/dropdowns are NOT violations ------ */
await participantPage.bringToFront();
await participantPage.evaluate(() => {
  // docs.google.com enforces Trusted Types, so build with DOM APIs, not innerHTML.
  const make = (tag, attrs = {}, text = "") => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    if (text) element.textContent = text;
    return element;
  };
  const form = make("form", { id: "answer-form" });
  const select = make("select", { id: "answer-select" });
  select.append(
    make("option", { value: "" }, "Pilih"),
    make("option", { value: "x" }, "X"),
    make("option", { value: "y" }, "Y"),
  );
  const listbox = make("div", { id: "answer-listbox", role: "listbox", tabindex: "0" });
  listbox.append(
    make("div", { id: "answer-option-1", role: "option", tabindex: "-1" }, "Opsi 1"),
    make("div", { id: "answer-option-2", role: "option", tabindex: "-1" }, "Opsi 2"),
  );
  form.append(
    make("input", { id: "answer-short", type: "text" }),
    make("textarea", { id: "answer-long" }),
    make("input", { id: "answer-radio-a", type: "radio", name: "q3", value: "a" }),
    make("input", { id: "answer-radio-b", type: "radio", name: "q3", value: "b" }),
    select,
    listbox,
  );
  document.body.prepend(form);
});
const beforeAnswer = await incidentCount();
await participantPage.click("#answer-short");
await participantPage.keyboard.type("jawaban singkat");
await participantPage.click("#answer-long");
await participantPage.keyboard.type("jawaban panjang");
await participantPage.keyboard.press("Tab");
await participantPage.click("#answer-radio-a");
await participantPage.click("#answer-radio-b");
await participantPage.click("#answer-select");
await sleep(2000);
await participantPage.keyboard.press("ArrowDown");
await participantPage.keyboard.press("Enter");
await participantPage.select("#answer-select", "y");
await participantPage.click("#answer-listbox");
await participantPage.click("#answer-option-2");
await participantPage.focus("#answer-option-1");
await participantPage.click("#answer-short");
await sleep(3500);
const afterAnswer = await incidentCount();
check(
  "klik isian, Tab, radio & dropdown bukan pelanggaran",
  afterAnswer === beforeAnswer,
  `${beforeAnswer} -> ${afterAnswer}`,
);
check("tidak ada peringatan saat menjawab", (await pendingWarning()) === null);

/* ------------------------- alt+tab: blur the exam tab ----------------------- */
const before = await adminPage.evaluate(async (examId) => {
  const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
  const state = await response.json();
  return state.incidents?.length ?? 0;
}, exam.id);

// Page-world visibility/focus overrides are invisible to isolated-world content scripts.
const { worker: focusWorker } = await findWorker();
await focusWorker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  await chrome.scripting.executeScript({
    target: { tabId: session.examTabId },
    world: "ISOLATED",
    func: () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("blur"));
    },
  });
});

await sleep(2500);

const afterHide = await waitFor(async () => {
  const state = await adminPage.evaluate(async (examId) => {
    const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
    return response.json();
  }, exam.id);
  return state.incidents?.length > 0 ? state : null;
}, 15000);

check(
  "alt+tab terdeteksi sebagai insiden",
  (afterHide?.incidents?.length ?? 0) > before,
  `${before} -> ${afterHide?.incidents?.length ?? 0}`,
);
check(
  "jenis insiden adalah FOCUS_LOST",
  afterHide?.incidents?.[0]?.incident_type === "FOCUS_LOST",
  afterHide?.incidents?.[0]?.incident_type ?? "none",
);
check(
  "insiden menyimpan domain",
  Boolean(afterHide?.incidents?.[0]?.page_host),
  afterHide?.incidents?.[0]?.page_host ?? "kosong",
);
check(
  "insiden menyimpan nama peserta",
  afterHide?.incidents?.[0]?.participant_name === "Peserta Fokus",
  afterHide?.incidents?.[0]?.participant_name ?? "kosong",
);

/* ------------------- Return to the exam tab: red overlay -------------------- */
const { worker: restoreWorker } = await findWorker();
await restoreWorker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  await chrome.scripting.executeScript({
    target: { tabId: session.examTabId },
    world: "ISOLATED",
    func: () => {
      delete document.visibilityState;
      delete document.hasFocus;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    },
  });
});
await sleep(2500);

const overlay = await participantPage.evaluate(() => {
  const host = document.getElementById("examguard-overlay-host");
  return host?.shadowRoot?.textContent ?? null;
});
check(
  "overlay peringatan muncul saat kembali",
  Boolean(overlay && overlay.includes("Sepertinya anda kehilangan fokus")),
  overlay?.slice(0, 70) ?? "none",
);

/* ------------- In-form page move: NOT a violation (docs.google.com) --------- */
const beforeNav = await adminPage.evaluate(async (examId) => {
  const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
  const state = await response.json();
  return state.incidents?.length ?? 0;
}, exam.id);

// A multi-page Google Form / Docs page move navigates the same tab to another
// docs.google.com URL. The old document reports hide/blur while unloading;
// that must not open an incident or raise a warning.
await participantPage.goto("https://docs.google.com/forms/d/e/focus-e2e-next/viewform", {
  waitUntil: "networkidle2",
});
await sleep(3500);

const afterNav = await adminPage.evaluate(async (examId) => {
  const response = await fetch(`/api/v1/exams/${examId}/monitor/state`);
  const state = await response.json();
  return state.incidents?.length ?? 0;
}, exam.id);
check(
  "pindah halaman sesama docs.google.com bukan pelanggaran",
  afterNav === beforeNav,
  `${beforeNav} -> ${afterNav}`,
);

const { worker: navWorker } = await findWorker();
const navWarning = await navWorker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  return session?.pendingWarning ?? null;
});
check("tidak ada peringatan baru setelah navigasi internal", navWarning === null);

// Google Forms can post a page transition without changing the URL.
const beforeSameUrl = await incidentCount();
const sameUrl = participantPage.url();
await Promise.all([
  participantPage.waitForNavigation({ waitUntil: "networkidle2" }),
  participantPage.evaluate(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = location.href;
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "pageHistory";
    field.value = "0,1";
    form.append(field);
    document.body.append(form);
    form.submit();
  }),
]);
await sleep(3500);
check("transisi benar-benar mempertahankan URL form", participantPage.url() === sameUrl);
const { worker: sameUrlWorker } = await findWorker();
const watcherInstalled = await sameUrlWorker.evaluate(async () => {
  const { session } = await chrome.storage.local.get("session");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: session.examTabId },
    world: "ISOLATED",
    func: () => window.__examguardFocusWatcherInstalled === true,
  });
  return result.result;
});
check("watcher tetap aktif setelah transisi halaman", watcherInstalled);
const afterSameUrl = await incidentCount();
check(
  "pindah halaman form dengan URL sama bukan pelanggaran",
  afterSameUrl === beforeSameUrl,
  `${beforeSameUrl} -> ${afterSameUrl}`,
);
check("tidak ada peringatan setelah pindah halaman URL sama", (await pendingWarning()) === null);

/* ------------------- Incident table shows the domain in UI ------------------ */
await adminPage.goto(`${BASE}/monitoring/${exam.id}`, { waitUntil: "networkidle2" });
await adminPage.waitForSelector("table", { timeout: 15000 });
await sleep(1500);
const tableText = await adminPage.evaluate(() => {
  const tables = [...document.querySelectorAll("table")];
  const incidentTable = tables[tables.length - 1];
  return incidentTable?.innerText ?? "";
});
check(
  "tabel insiden menampilkan domain",
  tableText.includes("DOMAIN") && tableText.includes("docs.google.com"),
  tableText.split("\n").slice(0, 3).join(" | ").slice(0, 110),
);
check(
  "tabel insiden menampilkan nama peserta",
  tableText.includes("Peserta Fokus"),
  tableText.slice(0, 80).replace(/\n/g, " "),
);

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error("FAILED:", failed.map((item) => item.label).join(", "));
  process.exit(1);
}
