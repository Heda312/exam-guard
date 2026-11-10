# Screenshots

Captured from the running application (Chrome, headless) by
`frontend/scripts/ui_shots.mjs`. Regenerate with:

```bash
cd frontend
npm install --no-save puppeteer-core
node scripts/ui_shots.mjs http://127.0.0.1:5199
```

| File | Screen |
|---|---|
| `01-setup.png` | First-run setup (requires `SETUP_SECRET`) |
| `02-login.png` | Admin/proctor login |
| `03-dashboard-empty.png` | Dashboard before any exam exists |
| `04-exams.png` | Exam list |
| `05-exam-detail-roster.png` | Exam detail — roster, manual add, CSV import |
| `06-exam-detail-proctors.png` | Exam detail — proctor assignment + per-permission checkboxes |
| `07-exam-detail-settings.png` | Exam detail — settings with "Uji URL" validation |
| `08-participant-form.png` | Participant registration form |
| `09-participant-filled.png` | Registration filled with a normalized name variant + commitment |
| `10-participant-waiting.png` | Waiting room — canonical name restored, NPM masked |
| `11-participant-exam.png` | Live exam — server countdown, readiness steps |
| `12-monitoring.png` | Proctor monitoring dashboard |
| `13-monitoring-incidents.png` | Monitoring with correlated incidents and review actions |
| `14-participant-detail.png` | Participant detail — event history (host only) and incidents |
| `15-proctors.png` | Proctor account management |
| `16-audit.png` | Audit log |
| `17-mobile-dashboard.png` | Responsive mobile layout |

Design tokens follow spec §4.2: forest `#18392C`/`#28543F`, sage `#91AA91`/`#DCE7D9`,
beige `#F1EBDD`/`#FFFCF6`, stone `#5F665F`, danger `#B54745`, warning `#C58A35`.
