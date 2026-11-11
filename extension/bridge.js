/**
 * Content-script bridge between the ExamGuard participant page and the extension
 * service worker. The page and extension exchange window.postMessage frames.
 *
 * Security notes:
 *  - Only messages from the same window and origin are relayed.
 *  - No page data is read; the bridge forwards only the documented messages.
 */
(function () {
  const PAGE_SOURCE = "examguard-web";
  const EXT_SOURCE = "examguard-extension";

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

  function sendToPage(type, payload = {}) {
    window.postMessage({ source: EXT_SOURCE, type, payload }, window.location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE) return;

    const { type, payload } = data;

    if (type === "web_ready") {
      sendToPage("extension_ready", { version: chrome.runtime.getManifest().version });
      return;
    }

    if (!RELAYED_TYPES.has(type)) return;

    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        sendToPage("extension_error", { message: chrome.runtime.lastError.message });
        return;
      }
      if (!response) return;

      // Relay the extension's monitoring state so the participant page can show
      // the status that used to live in the (now removed) popup.
      if (type === "get_state" && response.ok) {
        const session = response.session ?? null;
        sendToPage("extension_state", {
          monitoring: Boolean(session?.monitoring),
          buffered: Number(response.buffered ?? 0),
          needsAttention: Boolean(session?.needsAttention),
          version: response.version ?? null,
        });
        return;
      }

      if (response.ok === false) {
        sendToPage("extension_error", { reason: response.reason ?? "unknown" });
      }
    });
  });

  // Announce readiness as soon as the bridge is injected.
  sendToPage("extension_ready", { version: chrome.runtime.getManifest().version });
})();
