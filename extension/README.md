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
not in a popup.

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
| `NAVIGATION` | `chrome.tabs.onUpdated` (URL change) |
| `FOCUS_LOST` / `FOCUS_RESTORED` | `chrome.windows.onFocusChanged` |
| `CONNECTION_LOST` | monitoring stop / flush failure |

Full URLs are reduced to host names before upload. No page content, no keystrokes,
no screenshots, and no full browsing history are collected.

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

`host_permissions` covers the production origin plus local development origins.
To test against a LAN host such as `http://192.168.1.6:8080`, add it to both
`host_permissions` and `content_scripts.matches`, and update `API_BASE` in
`service-worker.js`.

## Icons

`icons/icon16.png`, `icon48.png`, `icon128.png` are required by the manifest.
