/**
 * ExamGuard copy guard.
 *
 * Runs on the exam form page (Google Forms) next to the focus watcher.
 * Cancels clipboard actions everywhere and text selection outside answer
 * fields, so questions cannot be copied and answers cannot be pasted, while
 * typing, selecting inside answer fields and every click stay untouched.
 *
 * Hardened against "enable copy" extensions: listeners sit in the capture
 * phase on window, the earliest point of the event path, ahead of any
 * document-level interceptor they register. Paste insertion is cancelled a
 * second time through beforeinput, which those interceptors do not steal,
 * and a USER-origin stylesheet keeps question text unselectable even when
 * events are intercepted. A periodic probe re-checks that the guard still
 * cancels events; if another extension neutralises it, a GUARD_TAMPERED
 * incident is raised instead of failing silently.
 *
 * Blocked clipboard attempts are reported to the service worker and uploaded
 * as monitoring events. Only trusted (user generated) events are reported;
 * selection and contextmenu blocking stay silent: mouse drags over question
 * text are constant noise, not reportable acts.
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
    if (event.isTrusted) report(event.type);
  }

  // Window capture runs before any document/html listener, whatever order
  // other extensions registered theirs in. stopPropagation (not immediate)
  // keeps the tamper probe observer below able to see the cancelled event.
  window.addEventListener("copy", blockClipboard, true);
  window.addEventListener("cut", blockClipboard, true);
  window.addEventListener("paste", blockClipboard, true);

  // Second paste net: interceptors steal the paste event but not beforeinput,
  // so the insertion itself is still cancelled.
  window.addEventListener(
    "beforeinput",
    (event) => {
      if (event.inputType !== "insertFromPaste" && event.inputType !== "insertFromDrop") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.isTrusted) report("paste");
    },
    true,
  );

  window.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  // Answer fields keep selection so participants can fix their own typing.
  window.addEventListener(
    "selectstart",
    (event) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  window.addEventListener(
    "dragstart",
    (event) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  /* Tamper probe: dispatch cancelable events and verify the guard still
   * cancels them. The observer registers on window after the guard, so it
   * only stays silent when an earlier interceptor killed the whole path. */
  const PROBE_INTERVAL_MS = 15000;
  const TAMPER_REPORT_THROTTLE_MS = 60000;
  let lastTamperReportAt = 0;

  function probe() {
    if (!document.body) return;
    const seen = [];
    const observe = (event) => seen.push(event.defaultPrevented);
    window.addEventListener("copy", observe, true);
    window.addEventListener("paste", observe, true);
    window.addEventListener("selectstart", observe, true);
    document.body.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new Event("selectstart", { bubbles: true, cancelable: true }));
    window.removeEventListener("copy", observe, true);
    window.removeEventListener("paste", observe, true);
    window.removeEventListener("selectstart", observe, true);
    if (seen.length === 3 && seen.every(Boolean)) return;
    const now = Date.now();
    if (now - lastTamperReportAt < TAMPER_REPORT_THROTTLE_MS) return;
    lastTamperReportAt = now;
    try {
      chrome.runtime.sendMessage(
        {
          type: "guard_tampered",
          payload: { url: window.location.href, at: new Date().toISOString(), seen },
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    } catch {
      /* extension context invalidated (update/reload) */
    }
  }

  setTimeout(probe, 2500);
  setInterval(probe, PROBE_INTERVAL_MS);
})();