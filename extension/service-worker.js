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

async function enqueueEvent(type, details = {}) {
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
  await updateBadge();

  if (buffer.length >= 10) void flushEvents();
}

async function flushEvents() {
  const session = await readSession();
  if (!session?.monitoring || !session.token) return;

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

async function heartbeat() {
  const session = await readSession();
  if (!session?.token) return;
  try {
    await fetch(`${apiBase}/participant/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Token": session.token,
      },
      body: JSON.stringify({ participant_session_id: session.participantSessionId }),
    });
  } catch {
    // Offline: the server marks the session CONNECTION_LOST on timeout.
  }
}

async function startCapture() {
  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  await enqueueEvent("FOCUS_RESTORED", { metadata: { reason: "monitoring_started" } });
}

async function stopMonitoring(reason = "manual") {
  const session = await readSession();
  if (!session) return null;
  await enqueueEvent("CONNECTION_LOST", { metadata: { reason } });
  await flushEvents();
  await chrome.alarms.clear(FLUSH_ALARM);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  const next = await patchSession({ monitoring: false, stoppedAt: Date.now() });
  await updateBadge();
  return next;
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
  await enqueueEvent("TAB_SWITCH", {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
    url,
    metadata: { host: hostOf(url) },
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const session = await readSession();
  if (!session?.monitoring) return;
  await enqueueEvent("NEW_TAB", {
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
    await enqueueEvent("TAB_CLOSED", {
      tabId,
      windowId: removeInfo.windowId,
      metadata: { examTab: true, isWindowClosing: Boolean(removeInfo.isWindowClosing) },
    });
    return;
  }
  await enqueueEvent("TAB_CLOSED", {
    tabId,
    windowId: removeInfo.windowId,
    metadata: { isWindowClosing: Boolean(removeInfo.isWindowClosing) },
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const session = await readSession();
  if (!session?.monitoring) return;
  await enqueueEvent("NAVIGATION", {
    tabId,
    windowId: tab.windowId,
    url: changeInfo.url,
    metadata: { host: hostOf(changeInfo.url) },
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const session = await readSession();
  if (!session?.monitoring) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await enqueueEvent("FOCUS_LOST", { metadata: { reason: "window_blur" } });
  } else {
    await enqueueEvent("FOCUS_RESTORED", { metadata: { reason: "window_focus" } });
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
    // Fallback when the waiting-room page is closed or was navigated away:
    // detect that the exam went live and launch the form automatically.
    const session = await readSession();
    if (!session?.participantSessionId || session.monitoring || session.needsAttention) return;
    if (!session.googleFormsUrl) return;
    const state = await fetchSessionState(session);
    if (!state) return;
    if (state.exam_status === "LIVE" && ["INITIALIZING", "READY", "REGISTERED", "WAITING"].includes(state.status)) {
      await launchExamForm();
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
          needsAttention: false,
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
        await stopMonitoring("exam_ended");
        await chrome.alarms.clear(WATCH_ALARM);
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
chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const session = await readSession();
  if (session?.monitoring) {
    await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
    await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  } else if (session?.participantSessionId) {
    await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 0.5 });
  }
  await updateBadge();
});
