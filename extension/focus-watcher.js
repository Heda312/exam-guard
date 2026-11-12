/**
 * ExamGuard focus watcher.
 *
 * Runs on the exam page itself (Google Forms). Chrome's
 * `windows.onFocusChanged` is unreliable for alt+tab: it fires with
 * WINDOW_ID_NONE only when the *window* loses focus, and a quick alt+tab can
 * be missed entirely because the service worker is asleep.
 *
 * The page's own `blur` / `visibilitychange` events are far more reliable: they
 * fire synchronously in the renderer the moment the tab is hidden or the window
 * loses focus, even for a fraction of a second.
 *
 * This script only *observes*; the service worker decides what is a violation
 * and owns all state.
 */
(function () {
  const MESSAGE_SOURCE = "examguard-focus";

  // Injected both by manifest (content_scripts) and by the service worker
  // (chrome.scripting.executeScript) as a safety net. Guard so listeners are
  // only registered once per page.
  if (window.__examguardFocusWatcherInstalled) return;
  window.__examguardFocusWatcherInstalled = true;

  let lastHiddenAt = 0;
  let lastVisibleAt = 0;

  function post(type, extra) {
    const payload = {
      url: window.location.href,
      at: new Date().toISOString(),
      ...extra,
    };
    try {
      window.postMessage(
        { source: MESSAGE_SOURCE, type, payload },
        window.location.origin,
      );
    } catch {
      /* page may have navigated away */
    }
    // Content scripts can talk to the service worker directly; this path is what
    // actually reaches the extension even when no page bridge is listening.
    try {
      chrome.runtime.sendMessage({ type: `focus:${type}`, payload }, () => {
        // Reading lastError prevents "Unchecked runtime.lastError" noise when the
        // worker is asleep and the message is dropped.
        void chrome.runtime.lastError;
      });
    } catch {
      /* extension context invalidated (update/reload) */
    }
  }

  function onHidden(reason) {
    // Ignore duplicate events from the same hide burst (blur + visibilitychange
    // fire together on alt+tab).
    const now = Date.now();
    if (now - lastHiddenAt < 400) return;
    lastHiddenAt = now;
    post("focus_lost", { reason });
  }

  function onVisible(reason) {
    const now = Date.now();
    if (now - lastVisibleAt < 400) return;
    lastVisibleAt = now;
    post("focus_restored", { reason });
  }

  window.addEventListener(
    "blur",
    () => onHidden("page_blur"),
    true,
  );

  window.addEventListener(
    "focus",
    () => onVisible("page_focus"),
    true,
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      onHidden("document_hidden");
    } else if (document.visibilityState === "visible") {
      onVisible("document_visible");
    }
  });

  // Page is being unloaded/navigated: also a loss of the exam page.
  window.addEventListener("pagehide", () => onHidden("page_hide"));
})();
