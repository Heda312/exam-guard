/**
 * ExamGuard MV3 service worker — participant entry point.
 *
 * Spec v1.3 references implemented here:
 *  §10.1 step 3-4  clicking the extension opens the participant registration page
 *  §10.1 step 13   the extension opens/keeps one dedicated waiting-room tab
 *  §10.1 step 15-18 on exam start the extension navigates that tab to Google Forms,
 *                   waits for readiness, then the backend marks MONITORING
 *  §10.3           the exam tab id is persisted in extension storage
 *  §14.2-14.4      event capture, durable buffering, alarms-based flush/heartbeat
 *
 * There is no popup: the action click is the participant entry point, and status
 * is surfaced in the participant web page plus the action badge.
 */

const DEFAULT_API_BASE = "https://exam.heda.my.id/api/v1";
const JOIN_PATH = "/join";

/** API base is derived from the participant page origin, so local and LAN
 *  deployments work without editing the extension. */
let apiBase = DEFAULT_API_BASE;

async function resolveApiBase(session) {
  if (session?.apiBase) apiBase = session.apiBase;
  return apiBase;
}

function siteOrigin() {
  return apiBase.replace(/\/api\/v1$/, "");
}

const FLUSH_ALARM = "examguard-flush";
const HEARTBEAT_ALARM = "examguard-heartbeat";
const WATCH_ALARM = "examguard-watch";

const MAX_BATCH = 40;
const MAX_BUFFER = 500;

const SESSION_KEY = "session";
const BUFFER_KEY = "eventBuffer";

/** Events that are uploaded immediately instead of waiting for a full batch.
 *  A quick tab switch used to sit in the buffer for up to 30 s, which made the
 *  proctor dashboard look like nothing happened. */
const PRIORITY_EVENTS = new Set([
  "TAB_SWITCH",
  "NEW_TAB",
  "TAB_CLOSED",
  "FOCUS_LOST",
  "FOCUS_RESTORED",
  "WINDOW_MINIMIZED",
]);

/** Local events that should raise a warning as soon as the participant is back
 *  on the exam tab. */
const VIOLATION_EVENTS = new Set([
  "TAB_SWITCH",
  "NEW_TAB",
  "TAB_CLOSED",
  "FOCUS_LOST",
  "WINDOW_MINIMIZED",
  "NAVIGATION",
]);

const WARNING_AUTO_DISMISS_MS = 15000;

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Session context is persisted in `storage.local` (not `storage.session`) so an
 * MV3 worker restart or a browser restart cannot lose an active exam tab or the
 * participant token (spec §10.3).
 */
async function readSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return stored[SESSION_KEY] ?? null;
}

async function writeSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function patchSession(patch) {
  const current = await readSession();
  if (!current) return null;
  const next = { ...current, ...patch };
  await writeSession(next);
  return next;
}

async function getBuffer() {
  const stored = await chrome.storage.local.get(BUFFER_KEY);
  return Array.isArray(stored[BUFFER_KEY]) ? stored[BUFFER_KEY] : [];
}

async function setBuffer(buffer) {
  await chrome.storage.local.set({ [BUFFER_KEY]: buffer.slice(-MAX_BUFFER) });
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

async function updateBadge() {
  const session = await readSession();
  const buffer = await getBuffer();

  if (!session) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  if (session.needsAttention) {
    await chrome.action.setBadgeBackgroundColor({ color: "#B54745" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  if (session.monitoring) {
    await chrome.action.setBadgeBackgroundColor({ color: "#28543F" });
    await chrome.action.setBadgeText({ text: buffer.length > 0 ? String(buffer.length) : "ON" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#C58A35" });
  await chrome.action.setBadgeText({ text: "…" });
}

/* ------------------------------------------------------------------ */
/* Entry point: open / focus the participant tab                       */
/* ------------------------------------------------------------------ */

function joinUrl(session) {
  const base = siteOrigin();
  return session?.examCode ? `${base}${JOIN_PATH}/${session.examCode}` : `${base}${JOIN_PATH}`;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return tab;
}

/** Open the participant page, or focus the tab that is already serving it. */
async function openParticipantPage() {
  const session = await readSession();
  await resolveApiBase(session);

  if (session?.examTabId && (await tabExists(session.examTabId))) {
    await focusTab(session.examTabId);
    return session.examTabId;
  }

  const tab = await chrome.tabs.create({ url: joinUrl(session), active: true });
  if (session) {
    await patchSession({ examTabId: tab.id });
  } else {
    await writeSession({ examTabId: tab.id, monitoring: false, apiBase });
  }
  return tab.id;
}

chrome.action.onClicked.addListener(() => {
  void openParticipantPage();
});

/* ------------------------------------------------------------------ */
/* Exam lifecycle: waiting room → Google Forms → monitoring            */
/* ------------------------------------------------------------------ */

/**
 * Navigate the persisted exam tab to the configured Google Forms URL, verify the
 * navigation, then mark the participant READY and start monitoring (§10.1 15-18).
 */
async function launchExamForm() {
  const session = await readSession();
  if (!session?.googleFormsUrl) return false;

  let tabId = session.examTabId;
  if (!tabId || !(await tabExists(tabId))) {
    const tab = await chrome.tabs.create({ url: session.googleFormsUrl, active: true });
    tabId = tab.id;
    await patchSession({ examTabId: tabId });
  } else {
    // Same-tab navigation (spec §10.3).
    await chrome.tabs.update(tabId, { url: session.googleFormsUrl, active: true });
    await focusTab(tabId);
  }

  const ready = await waitForExamForm(tabId, session.googleFormsUrl);
  if (!ready) {
    await patchSession({ needsAttention: true, lastError: "form_not_loaded" });
    await updateBadge();
    return false;
  }

  const okReady = await apiPost("/participant/ready", session, {
    participant_session_id: session.participantSessionId,
    page_url: session.googleFormsUrl,
  });
  if (!okReady) return false;

  const okMonitoring = await apiPost("/participant/monitoring/start", session, {
    participant_session_id: session.participantSessionId,
  });
  if (!okMonitoring) return false;

  await patchSession({ monitoring: true, needsAttention: false, startedAt: Date.now() });
  await startCapture();
  await updateBadge();
  return true;
}

/** Resolve once the tab finishes loading the expected host, or after a timeout. */
function waitForExamForm(tabId, expectedUrl, timeoutMs = 45000) {
  let expectedHost = "";
  try {
    expectedHost = new URL(expectedUrl).hostname.toLowerCase();
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(value);
    };

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== "complete") return;
      let host = "";
      try {
        host = new URL(tab.url ?? "").hostname.toLowerCase();
      } catch {
        host = "";
      }
      finish(host === expectedHost);
    }

    const timer = setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        let host = "";
        try {
          host = new URL(tab.url ?? "").hostname.toLowerCase();
        } catch {
          host = "";
        }
        finish(host === expectedHost && tab.status === "complete");
      } catch {
        finish(false);
      }
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);

    // The tab may already be loaded by the time we attach the listener.
    void (async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" && tab.url) {
          let host = "";
          try {
            host = new URL(tab.url).hostname.toLowerCase();
          } catch {
            host = "";
          }
          if (host === expectedHost) finish(true);
        }
      } catch {
        finish(false);
      }
    })();
  });
}

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

async function apiPost(path, session, body) {
  await resolveApiBase(session);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Token": session.token ?? "",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      await patchSession({ needsAttention: true, lastError: "token_rejected" });
      await updateBadge();
      return false;
    }
    return response.ok;
  } catch {
    await patchSession({ needsAttention: true, lastError: "network" });
    await updateBadge();
    return false;
  }
}

async function fetchSessionState(session) {
  await resolveApiBase(session);
  try {
    const response = await fetch(`${apiBase}/participant/session/${session.participantSessionId}`, {
      headers: { "X-Participant-Token": session.token ?? "" },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Event capture                                                       */
/* ------------------------------------------------------------------ */

function newEventId() {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Host-only extraction: full URLs (with query strings) are never uploaded. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function enqueueEvent(type, details = {}, options = {}) {
  const session = await readSession();
  if (!session?.monitoring) return;

  const event = {
    client_event_id: newEventId(),
    event_type: type,
    client_timestamp: new Date().toISOString(),
    tab_id: details.tabId ?? null,
    window_id: details.windowId ?? null,
    page_url: details.url ?? null,
    metadata: details.metadata ?? {},
    extension_version: chrome.runtime.getManifest().version,
  };

  const buffer = await getBuffer();
  buffer.push(event);
  await setBuffer(buffer);

  if (VIOLATION_EVENTS.has(type) && !details.skipWarning) {
    const previous = session.pendingWarning;
    await patchSession({
      pendingWarning: {
        incidentType: type,
        eventCount: (previous?.eventCount ?? 0) + 1,
        startedAt: previous?.startedAt ?? event.client_timestamp,
      },
    });
  }
  await updateBadge();

  if (options.priority || PRIORITY_EVENTS.has(type)) {
    // Do not await: capture callbacks must stay responsive, but the flush starts
    // right away instead of waiting for the 30 s alarm.
    void flushEvents();
  } else if (buffer.length >= 10) {
    void flushEvents();
  }
}

/** Serialise read-modify-write cycles on the buffer so bursts (switch + new tab)
 *  cannot overwrite each other. */
let enqueueChain = Promise.resolve();

function queueEvent(type, details = {}, options = {}) {
  const task = enqueueChain.then(() => enqueueEvent(type, details, options));
  enqueueChain = task.catch(() => undefined);
  return task;
}

async function flushOnce() {
  const session = await readSession();
  if (!session?.monitoring || !session.token) return;
  // The service worker is restarted constantly; the API base lives in the
  // persisted session, not in module state.
  await resolveApiBase(session);

  let buffer = await getBuffer();
  while (buffer.length > 0) {
    const batch = buffer.slice(0, MAX_BATCH);
    try {
      const response = await fetch(
        `${apiBase}/participant/events?participant_session_id=${encodeURIComponent(session.participantSessionId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Token": session.token,
          },
          body: JSON.stringify(batch),
        },
      );

      if (response.status === 401 || response.status === 403) {
        await patchSession({ monitoring: false, needsAttention: true, lastError: "token_rejected" });
        await updateBadge();
        return;
      }
      if (!response.ok) return; // keep the buffer, retry on the next alarm

      buffer = buffer.slice(batch.length);
      await setBuffer(buffer);
      await updateBadge();
    } catch {
      return; // offline: keep buffering
    }
  }
}

/** Calls are chained, so a flush started by a priority event cannot interleave
 *  with the alarm flush and upload the same batch twice. */
let flushChain = Promise.resolve();

function flushEvents() {
  const run = flushChain.then(flushOnce, flushOnce);
  flushChain = run.catch(() => undefined);
  return run;
}

async function heartbeat() {
  const session = await readSession();
  if (!session?.token) return;
  await resolveApiBase(session);
  try {
    const response = await fetch(`${apiBase}/participant/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Token": session.token,
      },
      body: JSON.stringify({ participant_session_id: session.participantSessionId }),
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    if (!data) return;
    if (["COMPLETED", "TIME_EXPIRED", "CANCELLED"].includes(data.status)) {
      await handleExamEnded(data.status);
      return;
    }
    if (typeof data.remaining_seconds === "number") {
      await patchSession({ remainingSeconds: data.remaining_seconds });
    }
  } catch {
    // Offline: the server marks the session CONNECTION_LOST on timeout.
  }
}

async function startCapture() {
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 0.5 });
  await queueEvent("FOCUS_RESTORED", { metadata: { reason: "monitoring_started" } }, { priority: true });
}

async function stopMonitoring(reason = "manual") {
  const session = await readSession();
  if (!session) return null;
  await queueEvent("CONNECTION_LOST", { metadata: { reason } }, { priority: true });
  await flushEvents();
  await chrome.alarms.clear(FLUSH_ALARM);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.clear(WATCH_ALARM);
  const next = await patchSession({ monitoring: false, stoppedAt: Date.now() });
  await updateBadge();
  return next;
}

/** The exam clock is authoritative on the server: heartbeat tells us when it
 *  ends, so the extension can stop capture and raise the end overlay. */
async function handleExamEnded(status = "COMPLETED") {
  const session = await readSession();
  if (!session) return;
  if (session.ended && !session.monitoring) {
    await showOverlayOnExamTab(status === "TIME_EXPIRED" ? "time_up" : "ended");
    return;
  }
  await flushEvents();
  await chrome.alarms.clear(FLUSH_ALARM);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.clear(WATCH_ALARM);
  await patchSession({
    monitoring: false,
    ended: true,
    endedStatus: status,
    pendingWarning: null,
    stoppedAt: Date.now(),
  });
  await updateBadge();
  await showOverlayOnExamTab(status === "TIME_EXPIRED" ? "time_up" : "ended");
}

/* ------------------------------------------------------------------ */
/* In-tab overlay (warning / exam ended)                               */
/* ------------------------------------------------------------------ */

const OVERLAY_LABELS = {
  TAB_SWITCH: "Berpindah tab",
  NEW_TAB: "Membuka tab baru",
  TAB_CLOSED: "Menutup tab",
  FOCUS_LOST: "Kehilangan fokus jendela ujian",
  WINDOW_MINIMIZED: "Meminimalkan jendela ujian",
  NAVIGATION: "Meninggalkan halaman ujian",
};

function overlayContent(kind, warning) {
  if (kind === "warning") {
    return {
      tone: "#c0362c",
      danger: true,
      icon: "!",
      title: "Sepertinya anda kehilangan fokus",
      message: "Harap kembali mengerjakan ujian.",
      note: "Aktivitas ini tercatat dan dilaporkan kepada pengawas.",
      button: "Saya mengerti",
      autoDismissMs: WARNING_AUTO_DISMISS_MS,
    };
  }
  if (kind === "time_up") {
    return {
      tone: "#b54745",
      danger: true,
      icon: "■",
      title: "Waktu ujian telah habis",
      message: "Waktu pengerjaan telah habis. Pemantauan aktivitas browser dihentikan.",
      note: "Pastikan jawaban pada formulir sudah terkirim sebelum menutup tab ini.",
      button: "Mengerti",
      autoDismissMs: 0,
    };
  }
  return {
    tone: "#b54745",
    danger: true,
    icon: "■",
    title: "Ujian telah berakhir",
    message: "Ujian telah diakhiri oleh pengawas. Pemantauan aktivitas browser dihentikan.",
    note: "Pastikan jawaban pada formulir sudah terkirim sebelum menutup tab ini.",
    button: "Mengerti",
    autoDismissMs: 0,
  };
}

/** Runs inside the exam tab (isolated world) and renders a shadow-DOM overlay
 *  that cannot be restyled by the exam page. Must stay self-contained: Chrome
 *  serialises this function, it cannot reference module scope. */
function renderOverlay(payload) {
  const HOST_ID = "examguard-overlay-host";
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
    "justify-content:center;padding:24px;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });

  const panel = document.createElement("div");
  panel.setAttribute("role", "alertdialog");
  panel.style.cssText = [
    "pointer-events:auto",
    "max-width:460px",
    "width:100%",
    "box-sizing:border-box",
    "font-family:'Inter','Segoe UI',system-ui,-apple-system,sans-serif",
    payload.danger
      ? "background:linear-gradient(180deg,#fff5f4 0%,#ffe9e6 100%)"
      : "background:#fffcf6",
    payload.danger ? "color:#7f1d1d" : "color:#18392c",
    "border-radius:18px",
    "padding:26px",
    "box-shadow:0 20px 48px rgba(24,57,44,0.3)",
    `border:1px solid ${payload.tone}`,
    `border-top:6px solid ${payload.tone}`,
  ].join(";");

  const icon = document.createElement("div");
  icon.textContent = payload.icon ?? "!";
  icon.setAttribute("aria-hidden", "true");
  icon.style.cssText = [
    "width:44px",
    "height:44px",
    "border-radius:50%",
    `background:${payload.tone}`,
    "color:#fff",
    "font-size:22px",
    "font-weight:700",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "margin:0 0 14px",
  ].join(";");

  const title = document.createElement("h2");
  title.textContent = payload.title;
  title.style.cssText = [
    "font-size:20px",
    "line-height:1.3",
    "margin:0 0 8px",
    payload.danger ? "color:#991b1b" : "color:#18392c",
  ].join(";");

  const message = document.createElement("p");
  message.textContent = payload.message;
  message.style.cssText = [
    "font-size:15px",
    "line-height:1.55",
    "margin:0 0 10px",
    "font-weight:600",
    payload.danger ? "color:#7f1d1d" : "color:#2f4038",
  ].join(";");

  const note = document.createElement("p");
  note.textContent = payload.note;
  note.style.cssText = [
    "font-size:12.5px",
    "line-height:1.55",
    "margin:0 0 18px",
    payload.danger ? "color:#b45309" : "color:#5f665f",
  ].join(";");

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = payload.button;
  button.style.cssText = [
    "width:100%",
    "padding:11px 16px",
    "border:0",
    "border-radius:12px",
    `background:${payload.tone}`,
    "color:#fff",
    "font-family:inherit",
    "font-size:14px",
    "font-weight:600",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", () => host.remove());

  panel.append(icon, title, message, note, button);
  shadow.append(panel);
  document.documentElement.appendChild(host);

  if (payload.autoDismissMs > 0) {
    setTimeout(() => host.remove(), payload.autoDismissMs);
  }
}

async function showOverlay(tabId, kind, warning) {
  if (!tabId) return false;
  if (!(await tabExists(tabId))) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderOverlay,
      args: [overlayContent(kind, warning)],
    });
    return true;
  } catch {
    // e.g. the tab shows a chrome:// page; the web-page modal still covers it.
    return false;
  }
}

async function isTabActive(tabId, windowId = null) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (windowId !== null && tab.windowId !== windowId) return false;
    return Boolean(tab.active);
  } catch {
    return false;
  }
}

async function showPendingWarning(tabId) {
  const session = await readSession();
  if (!session?.pendingWarning) return false;
  const shown = await showOverlay(tabId, "warning", session.pendingWarning);
  if (shown) await patchSession({ pendingWarning: null });
  return shown;
}

async function showOverlayOnExamTab(kind) {
  const session = await readSession();
  if (!session?.examTabId) return false;
  return showOverlay(session.examTabId, kind);
}

/* ----------------------------- Capture listeners ----------------------------- */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const session = await readSession();
  if (!session?.monitoring) return;

  let url = null;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    url = tab.url ?? null;
  } catch {
    /* tab already gone */
  }

  // Back on the exam tab: close the episode and surface the pending warning.
  if (session.examTabId && activeInfo.tabId === session.examTabId) {
    await queueEvent(
      "FOCUS_RESTORED",
      {
        tabId: activeInfo.tabId,
        windowId: activeInfo.windowId,
        url,
        metadata: { reason: "exam_tab_returned" },
      },
      { priority: true },
    );
    if (session.pendingWarning) await showPendingWarning(activeInfo.tabId);
    return;
  }

  await queueEvent("TAB_SWITCH", {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
    url,
    metadata: { host: hostOf(url) },
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const session = await readSession();
  if (!session?.monitoring) return;
  await queueEvent("NEW_TAB", {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? null,
    metadata: { host: hostOf(tab.url) },
  });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const session = await readSession();
  if (!session?.monitoring) return;
  if (tabId === session.examTabId) {
    // The exam tab itself was closed: keep the timer running, flag for the proctor.
    await patchSession({ examTabId: null });
    await queueEvent("TAB_CLOSED", {
      tabId,
      windowId: removeInfo.windowId,
      metadata: { examTab: true, isWindowClosing: Boolean(removeInfo.isWindowClosing) },
    });
    return;
  }
  await queueEvent("TAB_CLOSED", {
    tabId,
    windowId: removeInfo.windowId,
    metadata: { isWindowClosing: Boolean(removeInfo.isWindowClosing) },
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const session = await readSession();
  if (!session?.monitoring) return;
  // Only the exam tab's navigations matter: leaving that tab is the violation.
  // Navigating in a different tab (or the proctor dashboard) is not the
  // participant leaving the form.
  if (!session.examTabId || tabId !== session.examTabId) return;

  const examHost = hostOf(session.googleFormsUrl ?? "");
  const nextHost = hostOf(changeInfo.url);
  // Google redirects forms.gle → docs.google.com; both are still the exam page.
  const googleFormHosts = new Set(["docs.google.com", "forms.google.com", "forms.gle"]);
  const sameExamHost = Boolean(
    nextHost &&
      (nextHost === examHost || (googleFormHosts.has(nextHost) && googleFormHosts.has(examHost ?? ""))),
  );

  // Navigating inside the exam form (redirect, reload, page transition) is not
  // "leaving the exam"; only a navigation to another host is a violation.
  if (!sameExamHost) {
    await queueEvent("NAVIGATION", {
      tabId,
      windowId: tab.windowId,
      url: changeInfo.url,
      metadata: { host: nextHost },
    });
  }

  // Navigating back into the exam form is another "returned to the exam page"
  // moment, even though the tab never lost activation.
  if (sameExamHost && session.pendingWarning) {
    await showPendingWarning(tabId);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const session = await readSession();
  if (!session?.monitoring) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await queueEvent("FOCUS_LOST", { metadata: { reason: "window_blur" } }, { priority: true });
    return;
  }

  const examTabActive =
    session.examTabId !== null && session.examTabId !== undefined
      ? await isTabActive(session.examTabId, windowId)
      : false;

  if (!examTabActive) {
    // Another browser window came forward while the exam tab is not in view.
    await queueEvent("FOCUS_LOST", { metadata: { reason: "window_switched" } }, { priority: true });
    return;
  }

  await queueEvent("FOCUS_RESTORED", { metadata: { reason: "window_focus" } }, { priority: true });
  if (session.pendingWarning) {
    await showPendingWarning(session.examTabId);
  }
});

/* ------------------------------- Alarms ------------------------------------ */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    await flushEvents();
    return;
  }
  if (alarm.name === HEARTBEAT_ALARM) {
    await heartbeat();
    await flushEvents();
    return;
  }
  if (alarm.name === WATCH_ALARM) {
    // Fallback when the waiting-room page is closed or was navigated away.
    // Deliberately does NOT navigate the tab: the participant must press
    // "Buka ujian" themselves (requirement: no auto-redirect on exam start).
    // The alarm only keeps the badge/state fresh and re-opens the waiting room.
    const session = await readSession();
    if (!session?.participantSessionId || session.monitoring || session.ended) return;
    const state = await fetchSessionState(session);
    if (!state) return;
    const examOpen =
      state.exam_status === "LIVE" &&
      ["INITIALIZING", "READY", "REGISTERED", "WAITING"].includes(state.status);
    await patchSession({ examOpen: Boolean(examOpen), lastKnownStatus: state.status });
    await updateBadge();
    // If the exam tab was lost (browser restart), bring the participant back to
    // a page where the "Buka ujian" button is available.
    const tabAlive = session.examTabId ? await tabExists(session.examTabId) : false;
    if (!tabAlive && examOpen) {
      await openParticipantPage();
    }
  }
});

/* ----------------------- Web page bridge (content) -------------------------- */
const RELAYED_TYPES = new Set([
  "session_registered",
  "exam_started",
  "exam_ended",
  "page_ready",
  "monitoring_started",
  "stop_monitoring",
  "get_state",
  "open_participant_page",
  "violation_warning",
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !RELAYED_TYPES.has(message.type)) {
      sendResponse({ ok: false, reason: "unknown_message" });
      return;
    }

    switch (message.type) {
      case "open_participant_page": {
        sendResponse({ ok: true, tabId: await openParticipantPage() });
        break;
      }
      case "session_registered": {
        const current = (await readSession()) ?? {};
        // Derive the API base from the page that registered, so the extension
        // works against localhost, LAN hosts and production without edits.
        const pageOrigin = sender.tab?.url ? new URL(sender.tab.url).origin : null;
        const nextApiBase = pageOrigin ? `${pageOrigin}/api/v1` : current.apiBase ?? DEFAULT_API_BASE;
        apiBase = nextApiBase;
        await writeSession({
          ...current,
          participantSessionId: message.payload.participantSessionId,
          examCode: message.payload.examCode,
          googleFormsUrl: message.payload.googleFormsUrl ?? null,
          token: message.payload.token ?? current.token ?? null,
          examTabId: sender.tab?.id ?? current.examTabId ?? null,
          apiBase: nextApiBase,
          monitoring: false,
          ended: false,
          needsAttention: false,
          pendingWarning: null,
        });
        await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 0.5 });
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case "exam_started": {
        await patchSession({
          googleFormsUrl: message.payload.googleFormsUrl ?? (await readSession())?.googleFormsUrl ?? null,
          examTabId: message.payload.examTabId ?? (await readSession())?.examTabId ?? null,
        });
        const launched = await launchExamForm();
        sendResponse({ ok: launched });
        break;
      }
      case "page_ready":
      case "monitoring_started": {
        const launched = await launchExamForm();
        sendResponse({ ok: launched });
        break;
      }
      case "exam_ended": {
        const status =
          typeof message.payload?.status === "string" ? message.payload.status : "COMPLETED";
        await handleExamEnded(status);
        await chrome.alarms.clear(WATCH_ALARM);
        sendResponse({ ok: true });
        break;
      }
      case "violation_warning": {
        const session = await readSession();
        if (!session) {
          sendResponse({ ok: false, reason: "no_session" });
          break;
        }
        const warning = {
          incidentType:
            typeof message.payload?.incidentType === "string"
              ? message.payload.incidentType
              : "TAB_SWITCH",
          eventCount: Number(message.payload?.eventCount ?? 1) || 1,
          startedAt:
            typeof message.payload?.startedAt === "string" ? message.payload.startedAt : null,
        };
        // Always remember it: the participant usually sees it after returning
        // to the exam tab, not while the violation is happening.
        await patchSession({ pendingWarning: warning });
        const examTabActive = session.examTabId ? await isTabActive(session.examTabId) : false;
        if (examTabActive) {
          const shown = await showOverlay(session.examTabId, "warning", warning);
          if (shown) await patchSession({ pendingWarning: null });
        }
        sendResponse({ ok: true });
        break;
      }
      case "stop_monitoring": {
        sendResponse({ ok: true, session: await stopMonitoring("web_request") });
        break;
      }
      case "get_state": {
        const session = await readSession();
        const buffer = await getBuffer();
        sendResponse({
          ok: true,
          session,
          buffered: buffer.length,
          version: chrome.runtime.getManifest().version,
        });
        break;
      }
      default:
        sendResponse({ ok: false, reason: "unhandled" });
    }
  })();
  return true; // async response
});

/* ------------------------------- Lifecycle -------------------------------- */

/** Re-open the exam tab after Chrome was closed and started again.
 *
 *  Closing the browser destroys the exam tab, so `examTabId` points at a dead
 *  tab id and nothing can be captured any more. On startup we re-open the form
 *  (when monitoring was active) or the participant page, then restart the
 *  alarms so the participant shows up on the proctor dashboard again.
 */
async function recoverAfterBrowserRestart() {
  const session = await readSession();
  if (!session?.participantSessionId) {
    await updateBadge();
    return;
  }

  const tabAlive =
    session.examTabId !== null &&
    session.examTabId !== undefined &&
    (await tabExists(session.examTabId));

  if (session.monitoring) {
    if (tabAlive) {
      // Same browser session: just make sure the alarms are running again.
      await startCapture();
      await updateBadge();
      return;
    }

    const url = session.googleFormsUrl;
    if (url) {
      const tab = await chrome.tabs.create({ url, active: true });
      await patchSession({ examTabId: tab.id ?? null, pendingWarning: null });
      await startCapture();
      await queueEvent(
        "FOCUS_RESTORED",
        {
          tabId: tab.id,
          url,
          metadata: { reason: "browser_restarted" },
        },
        { priority: true },
      );
      await flushEvents();
      await updateBadge();
      return;
    }
  }

  // Not monitoring (or no form URL): send the participant back to the page
  // where they can press "Buka ujian" again.
  if (!tabAlive) {
    await openParticipantPage();
  }
  await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 0.5 });
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await recoverAfterBrowserRestart();
  } catch {
    await updateBadge();
  }
});
