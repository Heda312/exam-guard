# ExamGuard Chrome Extension

MV3 extension that records examination-time browser activity for an active
ExamGuard participant session.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the ExamGuard action to the toolbar.

## What it records

Only events required for the active examination (spec §14.2):

| Event | Source API |
|---|---|
| `TAB_SWITCH` | `chrome.tabs.onActivated` |
| `NEW_TAB` | `chrome.tabs.onCreated` |
| `TAB_CLOSED` | `chrome.tabs.onRemoved` |
| `NAVIGATION` | `chrome.tabs.onUpdated` (URL change) |
| `FOCUS_LOST` / `FOCUS_RESTORED` | `chrome.windows.onFocusChanged` |
| `CONNECTION_LOST` | monitoring stop / flush failure |

Full URLs are reduced to host names before upload. No page content, no keystrokes,
no screenshots, and no full browsing history are collected.

## Architecture

```
participant page  ──postMessage──▶  bridge.js (content script)
                                          │ chrome.runtime.sendMessage
                                          ▼
                                   service-worker.js
                                     │ chrome.storage.session (session + token)
                                     │ chrome.storage.local  (event buffer)
                                     ▼
                          POST /api/v1/participant/events
```

- The event buffer is durable across service-worker restarts.
- Events are removed only after a confirmed `2xx` response.
- A `401/403` response stops monitoring and flags the popup with "Perlu tindakan".
- Heartbeats and flushes run on `chrome.alarms` (0.5 min) so they survive MV3
  worker suspension.

## Icons

`icons/icon16.png`, `icon48.png`, `icon128.png` are required by the manifest.
Generate them from the brand mark, or copy any PNG with those dimensions into
`extension/icons/` before loading the extension.
