---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- UI-1  -- `role="tab"` sites without the keyboard model: the My Department agent panel's day tabs and the Inbound drill's Volume / Abandon % sub-tabs now have roving tabindex plus Left/Right/Home/End (the agent app's own tabs already had it, CL-13)
- UI-2  -- the agent page's loading and error lines are live regions (status / alert)
- CL-6  -- agent app: a rejected range no longer wipes the numbers or leaves the controls naming the rejected range; a custom range is clamped to the latest data date; the History tab gets a Retry
- CL-7  -- agent app: 'use strict' is the first statement, so strict mode is actually on
- CL-8  -- the agent page states the work window from the pinned constants, including the CSR family's 8:00 start (R49)
- SEC-4 follow-on (owner) -- when the wait lookup hits its 3,000-row ceiling, the agent page says where wait times stop
Files modified:
- apps-script/department-dashboard/AgentHome.gs
- apps-script/department-dashboard/Code.gs
- apps-script/department-dashboard/Config.gs (comment only)
- apps-script/department-dashboard/agent.html
- apps-script/department-dashboard/agentApp.html
- apps-script/department-dashboard/script-10-escalations.html
- apps-script/department-dashboard/script-9-inbound-direct.html
- tools/ui-harness/build-agent.js, drive-agent.js, drive-agentpanel.js
- tests/unit/agent-home.test.js, tests/unit/client-correctness.test.js
- docs/client-ui-conventions.md, docs/module-dependencies.md (regenerated), docs/next-steps.md, tests/README.md

CHANGES:
UI-1 | script-10-escalations.html | apDayHtml_ gives each tab an id and tabindex (0 for the selected tab, -1 otherwise), the tablist an aria-label, and the tabpanel aria-labelledby. apWire_'s keydown handles ArrowLeft/Right (wrap) and Home/End, re-renders the day on the new tab and re-focuses it -- the R12-9 IR pattern, kept per-site like IR's.
UI-1 | script-9-inbound-direct.html | the drill sub-tabs carry tabindex; a click moves the tab stop; a keydown on the tablist selects through the existing click handler and moves focus.
UI-2 | agent.html | #agent-error / #agent-hist-error get role="alert"; #agent-loading / #agent-hist-loading get role="status" aria-live="polite".
CL-6 | agentApp.html | load() records the window it asked for and sets lastGood_ only after a successful render. On failure with a prior window it restores `win`, repaints the controls, re-shows the untouched body and shows an inline "Couldn't load X: <server message>. Still showing Y." With no prior window it falls back to the old full error. Apply clamps `to` to latestIso and refuses a range starting after it. The date inputs get max=latestIso. showHistError_ appends a Retry button that calls loadHistory_().
CL-7 | agentApp.html | 'use strict' moved to the top of the IIFE; the stray one below initAgentMode_ is removed.
CL-8 | AgentHome.gs, Code.gs, agent.html, agentApp.html, build-agent.js | new agentWorkWindow_() returns {cst, pst, earlyCst, earlyQueues} from DASHBOARD_WORK_WINDOW / DASHBOARD_EARLY_WINDOW. Code.gs injects it as workWindowJson; the harness injects the same call. The footer's #agent-ww is filled with "8:30 AM – 5:00 PM CST (from 8:00 AM for calls through the A_Q_CSR, A_Q_Intake, Backup CSR, A_Q_Spanish queues)". The floor is per QUEUE, so the page names the queues rather than guessing; the literal stays only as the injection fallback. The Config comment ("no surface renders it yet") is updated.
SEC-4 | AgentHome.gs, agentApp.html | ahWaitJoin_ records coverFrom (the last kept row's date, newest first) when truncated. getAgentHome carries meta.waitsTruncated / meta.waitsCoverFrom. renderMissed adds a note: "Wait times cover your most recent calls (from <day> on) — earlier rings in this window show the time only. Pick a shorter range to see them."

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 2396 tests, 2395 pass, 0 fail (1 skipped, pre-existing).
- `ci:ui` (CI=true): all stages green, incl. 11 new rendered checks:
  - drive-agent: CL-8 footer; SEC-4 note; CL-6 numbers kept, controls restored, clamp, Retry shown, Retry loads; UI-2 roles; second page clean.
  - drive-agentpanel: UI-1 ArrowLeft, End.
- Lint clean; INV-16 in sync; module map regenerated (Code.gs → AgentHome.gs).
- 9 bites, all failing a test as they should:
  - 7 unit: CL-7, UI-2, UI-1 inbound, CL-6, SEC-4 coverFrom, SEC-4 meta, CL-8 helper.
  - 2 rendered: the UI-1 panel keydown and the CL-6 restore. The CL-6 bite reproduced the original bug exactly: body hidden, controls on the rejected 7-day range.
- Regression scenarios: S56 (inline agent panel) is covered by drive-agentpanel, PASS. No scenario covers the agent app; drive-agent is its rendered check.
REGRESSION RISKS:
- CL-7 turns strict mode on for the whole agent app. drive-agent exercises boot, both tabs, presets, custom range, the failure paths and the 360 px layout without a page error. A sloppy-mode construct on an untested path would now throw instead of passing silently.
- SEC-4: agentHome detail blobs cached before the deploy lack waitsTruncated, so the note can be missing for up to 6 h (no cache bump; it is a display field, not an aggregation rule).
- UI-1: each agent-panel arrow press re-renders the day view (as a click already did).
INVARIANTS AT RISK: None.
- INV-06 mirror family: agentWorkWindow_ reads the already-pinned display constants and copies none.
- Privacy pin: no teammate identity is added -- coverFrom is a date.
- INV-01 n/a.
NET SCORE: 1 − 0 = 1
- Would fire this month: CL-8, wherever the agent app is live for a CSR-family agent.
- Accessibility / latent: the rest.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The manager client's work-window pill still shows 8:30 for every dept (the R49 per-queue understatement noted in Config.gs). The agent page now names the CSR-family queues; the pill needs a per-dept rule.
- PIPE-7 (asked about this session): the recommended design is option A -- on "already in history", check Neon for the date's per-call rows and run the per-call backfill when none are there. Awaiting the owner's go-ahead.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made: client-ui-conventions.md (the tabs rule now lists all four tab sites; new UI-2 live-region rule), tests/README.md, next-steps.md (Batch 9 row; the stale summary row on line 31 fixed).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
