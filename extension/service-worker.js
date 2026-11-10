/**
 * ExamGuard MV3 service worker.
 *
 * Responsibilities (spec §14):
 *  - Keep the active participant session in chrome.storage.session.
 *  - Record only the events required for the active examination.
 *  - Buffer events durably and flush them in batches with retry.
 *  - Never persist full browsing history; store host names only.
 */

const API_BASE = "https://exam.heda.my.id/api/v1";
const FLUSH_ALARM = "examguard-flush";
const HEARTBEAT_ALARM = "examguard-heartbeat";
const MAX_BATCH = 40;
const MAX_BUFFER = 500;

const SESSION_KEY = "session";
const BUFFER_KEY = "eventBuffer";
const CONFIG_KEY = "config";

/** @returns {Promise<{session: any|null, config: any|null}>} */
async function readState() {
  const stored = await chrome.storage.session.get([SESSION_KEY, CONFIG_KEY]);
  return { session: stored[SESSION_KEY] ?? null, config: stored[CONFIG_KEY] ?? null };
}

async function getBuffer() {
  const stored = await chrome.storage.local.get(BUFFER_KEY);
  return Array.isArray(stored[BUFFER_KEY]) ? stored[BUFFER_KEY] : [];
}

async function setBuffer(buffer) {
  await chrome.storage.local.set({ [BUFFER_KEY]: buffer.slice(-MAX_BUFFER) });
}

function newEventId() {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Queue a raw monitoring event. Only meaningful while monitoring is active.
 * @param {string} type
 * @param {object} details
 */
async function enqueueEvent(type, details = {}) {
  const { session } = await readState();
  if (!session || session.monitoring !== true) return;

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

  if (buffer.length >= 10) {
    void flushEvents();
  }
}

/** Host-only extraction: full URLs (with query strings) are never sent. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function updateBadge() {
  const { session } = await readState();
  const buffer = await getBuffer();
  if (!session) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  if (session.monitoring) {
    await chrome.action.setBadgeBackgroundColor({ color: "#28543F" });
    await chrome.action.setBadgeText({ text: buffer.length > 0 ? String(buffer.length) : "ON" });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#C58A35" });
    await chrome.action.setBadgeText({ text: "…" });
  }
}

/**
 * Flush buffered events to the ExamGuard API.
 * Events are removed only after a confirmed 2xx response.
 */
async function flushEvents() {
  const { session } = await readState();
  if (!session || !session.token) return;

  let buffer = await getBuffer();
  if (buffer.length === 0) return;

  while (buffer.length > 0) {
    const batch = buffer.slice(0, MAX_BATCH);
    try {
      const response = await fetch(
        `${API_BASE}/participant/events?participant_session_id=${encodeURIComponent(session.participantSessionId)}`,
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
        // Token rotated or session revoked: stop monitoring and surface the state.
        await chrome.storage.session.set({
          [SESSION_KEY]: { ...session, monitoring: false, needsAttention: true },
        });
        await updateBadge();
        return;
      }

      if (!response.ok) {
        // Keep events buffered and retry on the next alarm.
        return;
      }

      buffer = buffer.slice(batch.length);
      await setBuffer(buffer);
      await updateBadge();
    } catch {
      // Network failure: keep the buffer and retry later.
      return;
    }
  }
}

async function heartbeat() {
  const { session } = await readState();
  if (!session || !session.token) return;
  try {
    await fetch(`${API_BASE}/participant/heartbeat`, {
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

async function startMonitoring(session) {
  const next = { ...session, monitoring: true, startedAt: Date.now() };
  await chrome.storage.session.set({ [SESSION_KEY]: next });

  await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  await updateBadge();
  await enqueueEvent("FOCUS_RESTORED", { metadata: { reason: "monitoring_started" } });
  return next;
}

async function stopMonitoring(reason = "manual") {
  const { session } = await readState();
  if (!session) return null;
  await enqueueEvent("CONNECTION_LOST", { metadata: { reason } });
  await flushEvents();
  const next = { ...session, monitoring: false, stoppedAt: Date.now() };
  await chrome.storage.session.set({ [SESSION_KEY]: next });
  await chrome.alarms.clear(FLUSH_ALARM);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await updateBadge();
  return next;
}

/* ----------------------------- Event capture ----------------------------- */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { session } = await readState();
  if (!session?.monitoring) return;
  let url = null;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    url = tab.url ?? null;
  } catch {
    /* tab may already be gone */
  }
  await enqueueEvent("TAB_SWITCH", {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
    url,
    metadata: { host: hostOf(url) },
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const { session } = await readState();
  if (!session?.monitoring) return;
  await enqueueEvent("NEW_TAB", {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? null,
    metadata: { host: hostOf(tab.url) },
  });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const { session } = await readState();
  if (!session?.monitoring) return;
  await enqueueEvent("TAB_CLOSED", {
    tabId,
    windowId: removeInfo.windowId,
    metadata: { isWindowClosing: Boolean(removeInfo.isWindowClosing) },
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const { session } = await readState();
  if (!session?.monitoring) return;
  await enqueueEvent("NAVIGATION", {
    tabId,
    windowId: tab.windowId,
    url: changeInfo.url,
    metadata: { host: hostOf(changeInfo.url) },
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const { session } = await readState();
  if (!session?.monitoring) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await enqueueEvent("FOCUS_LOST", { metadata: { reason: "window_blur" } });
  } else {
    await enqueueEvent("FOCUS_RESTORED", { metadata: { reason: "window_focus" } });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FLUSH_ALARM) {
    await flushEvents();
  } else if (alarm.name === HEARTBEAT_ALARM) {
    await heartbeat();
    await flushEvents();
  }
});

/* ------------------------- Web page bridge (content) ------------------------- */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "web_ready": {
        sendResponse({ ok: true, extension: true });
        break;
      }
      case "session_registered": {
        await chrome.storage.session.set({
          [SESSION_KEY]: {
            participantSessionId: message.payload.participantSessionId,
            examCode: message.payload.examCode,
            googleFormsUrl: message.payload.googleFormsUrl,
            token: message.payload.token ?? null,
            monitoring: false,
          },
        });
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case "page_ready":
      case "monitoring_started": {
        const { session } = await readState();
        if (session) {
          const next = await startMonitoring({
            ...session,
            googleFormsUrl: message.payload.googleFormsUrl ?? session.googleFormsUrl,
          });
          sendResponse({ ok: true, session: next });
        } else {
          sendResponse({ ok: false, reason: "no_session" });
        }
        break;
      }
      case "open_form": {
        const url = message.payload?.url;
        if (url) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) {
            await chrome.tabs.update(tabs[0].id, { url });
          } else {
            await chrome.tabs.create({ url });
          }
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, reason: "no_url" });
        }
        break;
      }
      case "stop_monitoring": {
        sendResponse({ ok: true, session: await stopMonitoring("web_request") });
        break;
      }
      case "get_state": {
        const state = await readState();
        const buffer = await getBuffer();
        sendResponse({ ok: true, session: state.session, buffered: buffer.length });
        break;
      }
      default:
        sendResponse({ ok: false, reason: "unknown_message" });
    }
  })();
  return true; // keep the message channel open for the async response
});

/* ------------------------------- Lifecycle ------------------------------- */
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ [SESSION_KEY]: null });
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const { session } = await readState();
  if (session?.monitoring) {
    await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
    await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  }
  await updateBadge();
});
