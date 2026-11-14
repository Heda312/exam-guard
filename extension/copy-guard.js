/**
 * ExamGuard copy guard.
 *
 * Runs on the exam form page (Google Forms) next to the focus watcher.
 * Cancels clipboard actions everywhere and text selection outside answer
 * fields, so questions cannot be copied and answers cannot be pasted, while
 * typing, selecting inside answer fields and every click stay untouched.
 *
 * Blocked clipboard attempts are reported to the service worker and uploaded
 * as monitoring events. Selection and contextmenu blocking stay silent:
 * mouse drags over question text are constant noise, not reportable acts.
 */
(function () {
  // Injected by manifest and by the service worker safety net; install once.
  if (window.__examguardCopyGuardInstalled) return;
  window.__examguardCopyGuardInstalled = true;

  // Holding Ctrl+C must not flood the incident log: one report per kind.
  const REPORT_THROTTLE_MS = 3000;
  const lastReportAt = { copy: 0, cut: 0, paste: 0 };

  function isEditable(node) {
    return Boolean(
      node &&
        node.closest &&
        node.closest('input, textarea, [contenteditable="true"], [contenteditable=""]'),
    );
  }

  function report(kind) {
    const now = Date.now();
    if (now - lastReportAt[kind] < REPORT_THROTTLE_MS) return;
    lastReportAt[kind] = now;
    try {
      chrome.runtime.sendMessage(
        {
          type: `clipboard:${kind}_attempt`,
          payload: { url: window.location.href, at: new Date().toISOString() },
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    } catch {
      /* extension context invalidated (update/reload) */
    }
  }

  function blockClipboard(event) {
    event.preventDefault();
    event.stopPropagation();
    report(event.type);
  }

  // Capture phase: cancel before any page handler can act on the clipboard.
  document.addEventListener("copy", blockClipboard, true);
  document.addEventListener("cut", blockClipboard, true);
  document.addEventListener("paste", blockClipboard, true);

  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    true,
  );

  // Answer fields keep selection so participants can fix their own typing.
  document.addEventListener(
    "selectstart",
    (event) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
    },
    true,
  );

  document.addEventListener(
    "dragstart",
    (event) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
    },
    true,
  );
})();