/**
 * Content-script bridge between the ExamGuard web page and the extension
 * service worker. The page and extension exchange window.postMessage frames.
 *
 * Security notes:
 *  - Only messages from the same window/origin are relayed.
 *  - No page data is read; the bridge only forwards the documented events.
 */
(function () {
  const PAGE_SOURCE = "examguard-web";
  const EXT_SOURCE = "examguard-extension";

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

    if (
      type !== "session_registered" &&
      type !== "page_ready" &&
      type !== "monitoring_started" &&
      type !== "open_form" &&
      type !== "stop_monitoring" &&
      type !== "get_state"
    ) {
      return;
    }

    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        sendToPage("extension_error", { message: chrome.runtime.lastError.message });
        return;
      }
      if (response && response.ok === false) {
        sendToPage("extension_error", { reason: response.reason ?? "unknown" });
      }
    });
  });

  // Announce readiness as soon as the bridge is injected.
  sendToPage("extension_ready", { version: chrome.runtime.getManifest().version });
})();
