---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18d-1 (owner: "I definitely want that tripwire") | Nothing cross-checked QCD against DQE, so a dept whose queue kept taking calls while its agent data went dark was invisible for two months (the Field Ops Power incident, 2026-06-17)
- R18d-2 (owner) | When DQE is unavailable for a dept, the Overview card should fall back to QCD — implemented as a LABELED queue lens, never a silent substitution
- R18d-3 (owner) | Email the admins when someone signs into the tool for the first time, or attempts to and is denied

Files modified:
- apps-script/department-dashboard/DqeSilenceWatch.gs (NEW)
- apps-script/department-dashboard/SystemHealth.gs
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/department-dashboard/script-3-overview.html
- apps-script/department-dashboard/styles.html
- apps-script/department-dashboard/Code.gs
- apps-script/department-dashboard/Auth.gs
- tests/unit/dqe-silence-watch.test.js (NEW), overview-dqe-silence.test.js (NEW), login-notify.test.js (NEW)
- tools/ui-harness/drive-smoke.js
- CLAUDE.md (operator index #44/#45, subsystem file list, dsConfirm-adjacent v20→v21 mention), docs/operator-state.md (#44, #45), docs/invariants.md (INV-30 v21), docs/architecture.md, docs/known-issues.md, docs/conventions.md, docs/client-ui-conventions.md

CHANGES:
R18d-1 | DqeSilenceWatch.gs | The cross-check the incident proved missing, as a flag-gated daily engine (the IngestWatchdog discipline). A dept is SILENT on a day when its mapped queues (getDeptQcdQueues_, INV-54) show QCD 'Total Calls' volume while ZERO DQE rows match its roster names (INV-04 exact — the same predicate the My Department table lives by, so it fires exactly when that page goes blind). Silent days grow a per-dept streak carrying accumulated calls; ONE email per episode once days >= 2 AND cumulative calls >= 5. The cumulative floor is the design decision that matters: a per-day volume bar would mean a 1-2-call dept (Denials — the incident's second casualty) never alerts; cumulative means it alerts on day 3. Recovery ends the episode and re-arms. Unreadable QCD or DQE reads are INCONCLUSIVE (state untouched) — a flaky read must never false-alarm or falsely clear. The DQE read goes through the DAL (getDqeReadSource_-aware with the cutover fallback), so the B-2 "every reader is cut over" rule holds by construction. Health page: svc readiness row (flagProp passed, per the Batch-3 rule) + an OPS-8 outcome row; 'SILENT' joined the prefix classifier. The alert email carries the incident runbook (col W check first).
R18d-2 | CompanyOverview.gs + script-3-overview.html | Per-dept `dqeSilence` (companyOverview:v21): zero DQE rings over the trailing 7 chart days while QCD daily volume > 0, computed from maps the blob already builds (no new read). The hole the owner asked about is real and the design rule closes it: QCD counts CALLS with an abandon-threshold semantic, DQE counts RINGS — feeding queue numbers into the tile's normal stats would show a number that silently changed species. So the fallback is an explicitly-labeled warn-railed block ("Agent data dark · last 7d — queue lens: N queue calls · M abandoned (P%)") above stats that keep their honest zeros. Rendered on grid tiles AND sub-queue cards (compact ⚠ on the collapsed strip — found live: the first probe planted the flag on Spanish, a child dept, and no badge appeared because children render through a different builder). Visible to managers too (queue-level data the QCD chips already show); NOT in the personalizeOverview_ strip list.
R18d-3 | Auth.gs + Code.gs | notifyLoginEvent_ in doGet, BEFORE the role branch so denied attempts notify too. Emails admins on FIRST sighting of an address and again on OUTCOME-CLASS change (denied→manager after a grant; dept reassignment; revocation — the key is admin | manager:<depts> | denied). Repeat visits with an unchanged outcome are silent: a who-showed-up signal, not a page-view log. State in the LOGIN_NOTIFY_SEEN Script Property, capped at 300 keys — past the cap new addresses still notify EVERY visit rather than silently dropping (the failure mode is extra signal, never lost signal). ON by default per the owner's ask (LOGIN_NOTIFY_ENABLED=false silences); best-effort inside doGet's try/catch, structurally unable to block a render. Denied-attempt mail carries the grant runbook (Access Control row / EMAIL_ALIASES).
tests | Three new suites (18 tests). dqe-silence-watch pins the episode semantics (day-1 watch, day-2 alert, once-per-episode, cumulative Denials case, recovery re-arm, no-signal days, carried-forward ghosts). overview-dqe-silence pins the detector (any ring = healthy; stale rings outside the window don't mask current silence). login-notify pins first/changed/silent-repeat, the dept-list-sensitive key, corrupt-store tolerance, and the full-store keep-notifying rule.
smoke | The Overview fixture turned out to ship a LIVE specimen of the incident: Billing has QCD rows and no DQE agents at all, so the REAL server code computes dqeSilence for it. The assertion became the positive test permanently — the silent dept gets the labeled badge, and no dept WITH ring activity does — data-driven off each tile's own Rung stat so fixture count drift can't break it. My first version asserted "no badge on a healthy fixture" and FAILED because the fixture was never healthy; the detector was right and the assertion's premise was wrong.

TEST RESULTS: passed. `node --test` 693/693 (was 675; +18); INV-16 green; cache-version-sync green across the v21 bump's six doc mentions; `npm run ci:ui` all stages (drive-smoke 84). One smoke iteration was mine to fix: the new Overview block navigated away from the dept page and stranded the downstream queue-calendar assertion, so it now restores the page state it found.

REGRESSION RISKS:
- The watchdog is read-only + flag-gated OFF; until installDqeSilenceWatchTrigger() runs it changes nothing.
- The tile badge appears for any QUEUE-ONLY dept — a dept with mapped queues and deliberately no rostered agents would show it permanently. Arguably correct (its agent view IS dark); if a real install has such a dept by design, the fix is judgment, not code.
- Login notify will burst on rollout day: every existing user's first post-deploy visit is a first sighting. Expected and arguably the point; LOGIN_NOTIFY_ENABLED=false silences it.
- doGet gained a Script Property read+write on notify paths only; repeat visits cost one property read.
- companyOverview:v21 invalidates warmed Overview blobs once on deploy (30-min tier).

INVARIANTS AT RISK: None violated. INV-01: the login notify writes a Script Property, not a spreadsheet; the watchdog RPCs are assertAdmin_-gated. INV-30 bumped properly (v21, six doc mentions synced, test-enforced). INV-04's exact-match semantics are deliberately REUSED by the watchdog so it agrees with the page it guards. The B-2 DAL rule holds (new DQE reader is cut over by construction).

NET SCORE: 3 production fixes − 0 new failure modes = 3
(The tripwire would have caught the incident on day 2 instead of day ~60. The queue-lens badge makes the same state visible passively. The login notify is a rollout-day request with a denied-attempt security angle.)

OPERATOR ACTIONS / DEPLOY:
- Run installDqeSilenceWatchTrigger() once (editor, admin) after deploying — the engine defaults OFF | BLOCKS DEPLOY: N (but the tripwire does nothing until this runs)
- Expect the first-sign-in email burst on rollout day; set LOGIN_NOTIFY_ENABLED=false if unwanted | BLOCKS DEPLOY: N
- The Phase 2 action still stands: populate Dept Config "Team Avg Excludes" | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The root cause itself (the phone-system caller-ID label for A_Q_FieldOps_Power / likely A_Q_Denials) is still an open operator action: fix the label, find-replace col W in the surviving Call_Legs sheets, force re-import the recoverable window, then backfillDQEHistoryUpsert() if on Neon read. The watchdog detects recurrence; it does not repair.
- The watchdog and the tile detector share a predicate shape but different windows (1 assessed day vs trailing 7) and different reads — deliberate (push needs day-precision streaks; the tile needs cheap in-blob maps), but worth one comment-level pointer at each other. Done in docs; a third consumer would justify extraction.

DOCUMENTATION UPDATES NEEDED:
- DONE: operator-state #44 (watchdog: enable, thresholds, episode semantics, incident backstory, Health rows) + #45 (login notify: default-on, outcome keys, cap semantics, rollout-day burst) + CLAUDE.md index lines; subsystem file list gained DqeSilenceWatch.gs; INV-30 v21; architecture tables; client-ui-conventions gained the labeled-lens design rule.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
