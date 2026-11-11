# ExamGuard Chrome Extension

MV3 extension for **participants**. Clicking the toolbar icon opens the ExamGuard
participant page; the extension then owns one exam tab, navigates it to the
Google Forms URL when the exam starts, and records examination-time browser
activity while monitoring is active.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the ExamGuard action to the toolbar.

## What clicking the icon does

There is **no popup**. `chrome.action.onClicked` is the participant entry point:

1. If a stored exam tab still exists → focus that tab.
2. Otherwise open `<origin>/join` (or `/join/<examCode>` when a session exists).
3. Store the tab id in `chrome.storage.local` as `examTabId`.

Monitoring status is shown in the participant web page and on the action badge —
not in a popup. During the exam the participant page is replaced by the Google
Form, so violation and end-of-exam notices are drawn directly on the form by the
extension (see below).

## Badge states

| Badge | Meaning |
|---|---|
| *(empty)* | No session yet |
| `…` | Registered, waiting for the exam to start |
| `ON` | Monitoring active, buffer empty |
| `1`–`500` | Monitoring active, N buffered events pending upload |
| `!` | Attention required (token rejected, network failure, form not loaded) |

## Flow (spec §10.1, §10.3)

```
click icon ──▶ open/focus participant tab ──▶ register (Exam ID + name + commitment)
                                                        │
                                                        ▼
                                            waiting room in that same tab
                                                        │  exam goes LIVE
                                                        ▼
                       extension navigates examTabId → Google Forms URL
                                                        │  tab load verified
                                                        ▼
                                 POST /participant/ready → POST /participant/monitoring/start
                                                        │
                                                        ▼
                                        capture events → batch upload
```

Trigger sources for the launch step (any one is sufficient):

- the waiting room polls the session and posts `exam_started` to the extension;
- the participant clicks **Buka formulir ujian sekarang**;
- the `examguard-watch` alarm (every 30 s) checks the session server-side, so the
  launch still happens if the waiting-room tab was closed.

The exam tab id is persisted in `chrome.storage.local` (survives worker restarts
and browser restarts), never only in service-worker globals.

## What it records

Only events required for the active examination (spec §14.2):

| Event | Source API |
|---|---|
| `TAB_SWITCH` | `chrome.tabs.onActivated` |
| `NEW_TAB` | `chrome.tabs.onCreated` |
| `TAB_CLOSED` | `chrome.tabs.onRemoved` (flagged when it is the exam tab) |
| `NAVIGATION` | `chrome.tabs.onUpdated` (exam tab only; Google form redirects are ignored) |
| `FOCUS_LOST` / `FOCUS_RESTORED` | `chrome.windows.onFocusChanged` (window-only switches count as lost) |
| `CONNECTION_LOST` | monitoring stop / flush failure |

Full URLs are reduced to host names before upload. No page content, no keystrokes,
no screenshots, and no full browsing history are collected.

## Violation and end-of-exam overlays

The participant page is unloaded when the exam tab navigates to Google Forms, so
the extension is the reliable notification surface during the exam:

- **Violation warning** — when the backend reports a violation, the worker stores
  `pendingWarning` in the session. The next time the participant is back on the
  exam tab (tab activated, window refocused, or the form re-loaded), a
  shadow-DOM overlay titled **Peringatan pelanggaran** is rendered on the page.
  Repeated violations accumulate `eventCount` until the overlay is shown.
- **Time up / exam ended** — the heartbeat response carries `status` and
  `remaining_seconds`. When the session expires or the proctor ends the exam, a
  persistent overlay is shown and capture stops. The participant web page (when
  still open) mirrors this with a modal over `/ws/participant/{id}`.

Violation events (`TAB_SWITCH`, `FOCUS_LOST`, `NAVIGATION`, …) flush immediately
through a serialized queue instead of waiting for the 30 s alarm, so a fast
tab switch is recorded within a second.

## Architecture

```
participant page ──postMessage──▶ bridge.js (content script)
                                        │ chrome.runtime.sendMessage
                                        ▼
                                 service-worker.js
                                   │ chrome.storage.local
                                   │   session  (token, examTabId, examCode, googleFormsUrl)
                                   │   eventBuffer (durable queue)
                                   ▼
                        POST /api/v1/participant/{ready,monitoring/start,events}
```

- The event buffer is durable; events are removed only after a confirmed `2xx`.
- A `401/403` response stops monitoring and sets the `!` badge.
- Flush and heartbeat run on `chrome.alarms` (30 s) so they survive MV3 worker
  suspension.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read tab URLs (host only is uploaded), navigate the exam tab |
| `storage` | Persist session context and the event buffer |
| `alarms` | Flush, heartbeat, and the exam-start watcher |
| `scripting` | Render the violation/time-up overlay on the Google Form tab |

`host_permissions` covers the production origin, local development origins, and
the Google Forms hosts (`docs.google.com`, `forms.google.com`, `forms.gle`). To
test against a LAN host such as `http://192.168.1.6:8080`, add it to both
`host_permissions` and `content_scripts.matches`; the API base is otherwise
derived from the participant page origin and stored with the session.

## Icons

`icons/icon16.png`, `icon48.png`, `icon128.png` are required by the manifest.
