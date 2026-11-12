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

  // Native controls and iframe focus can blur the window without leaving the document.
  const BLUR_CONFIRM_MS = 150;
  // A cancelled beforeunload must not leave focus detection suppressed.
  const UNLOAD_RESET_MS = 4000;

  let lastHiddenAt = 0;
  let lastVisibleAt = 0;
  let blurTimer = null;
  let unloading = false;
  let unloadResetTimer = null;

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

  function markUnloading() {
    unloading = true;
    clearTimeout(unloadResetTimer);
    unloadResetTimer = setTimeout(() => {
      unloading = false;
    }, UNLOAD_RESET_MS);
  }

  // Capture-phase listeners would mistake answer-field blur for window focus loss.
  window.addEventListener("blur", (event) => {
    if (event.target !== window) return;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      if (unloading || document.hasFocus()) return;
      onHidden("page_blur");
    }, BLUR_CONFIRM_MS);
  });

  window.addEventListener("focus", (event) => {
    if (event.target !== window) return;
    if (blurTimer) {
      // Transient blur that never became a reported loss.
      clearTimeout(blurTimer);
      blurTimer = null;
      return;
    }
    onVisible("page_focus");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (unloading) return;
      onHidden("document_hidden");
    } else if (document.visibilityState === "visible") {
      onVisible("document_visible");
    }
  });

  // Document unload also hides it; the worker distinguishes internal from external navigation.
  window.addEventListener("beforeunload", markUnloading);
  window.addEventListener("pagehide", markUnloading);
  window.addEventListener("pageshow", () => {
    unloading = false;
    clearTimeout(unloadResetTimer);
  });
})();
