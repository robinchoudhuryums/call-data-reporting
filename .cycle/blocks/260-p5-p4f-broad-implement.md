---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: From the follow-up plan of 2026-11-13 (owner notes, not scan findings): P5 (the `Other` roster column) and the four follow-on items listed in the P4 block -- P4-F1 whole percents on the Team Direct Calls card, P4-F2 the Direct view keeps its rows while a window loads, P4-F3 Team Rings and Team Outbound busy with the page, P4-F4 a fold control per side panel.
New capabilities (G/ST): None from the scan's expansion plan. P5 and P4-F4 are new capability; P4-F1 is a display change.
Files modified: apps-script/department-dashboard/Config.gs, CompanyOverview.gs, Coaching.gs, CacheWarm.gs, script-5-dept.html, script-9-inbound-direct.html, dashboard.html, styles.html; tests/unit/custodial-dept.test.js (new), team-direct-card.test.js; tools/ui-harness/drive-deptoutbound.js, README.md; tests/README.md; CLAUDE.md; docs/operator-state.md, client-ui-conventions.md, fix-history.md, regression-scenarios.md, module-dependencies.md; .cycle/STATE.md.

CHANGES:
P5 | Config.gs, CompanyOverview.gs, Coaching.gs, CacheWarm.gs | `CUSTODIAL_DEPTS` (`['Other']`) + `isCustodialDept_` (exact header match). `Other` is listed in `OVERVIEW_HIDDEN_DEPTS` (spelled out, not concatenated: a top-level reference across files depends on load order), so it has no Overview tile or chart line and no share of the company aggregate; `computeCoachingPreview_` and `coachingAllDeptGates_` skip it; `warmReportCaches_` skips it in every phase. It stays a department by name everywhere else. Verified first: every roster reader in all three projects stops at the first blank header, so a 17th column in V with W left blank is safe ahead of the insurance block in X.
P4-F1 | script-9-inbound-direct.html, script-5-dept.html | The card's headline rate and its table's % column are whole percents through `directWholeRate_(answered, missedFree)`, computed from the counts (82.45% is 82; rounding the served 82.5 would say 83). The served one-decimal figure stays in the tooltips. The Direct Calls report and the Direct view are unchanged.
P4-F2 | script-5-dept.html | `dcViewRender_` reads `TDC_.data || (busy ? tdcHeld_() : null)` and frosts on `TDC_.loading || TDC_.pending`, so the Direct view's rows stay under the frost instead of blanking; a held error is not shown over a load in flight.
P4-F3 | script-5-dept.html | `sideFrostArm_()` from `refresh()` on a same-department refresh frosts Team Rings and Team Outbound when visible; the LIVE repaint in `onData` and `onError` call `sideFrostDisarm_()`. Team Rings' own unfrost goes through `trpUnfrost_`, held back while the page is armed so the SWR pre-paint cannot clear it. Team Outbound is also frosted while its own request is out and cleared on the reply or the failure.
P4-F4 | dashboard.html, script-5-dept.html, styles.html | Each of the four side panels has a `.side-collapse` button in its header (`aria-expanded`, labelled, keyboard-operable). `.is-collapsed` hides every child but the header and gives the height back. Stored per viewer in `cdr.dept.side.collapsed` with an in-memory working copy, so it works where storage is blocked. Wired once for every role from `obViewSync_`; the control is in the print-hidden list.

TEST RESULTS: passed — `TZ=America/Chicago node --test` 3082 pass, 0 fail, 1 skipped (11 new tests: 4 in custodial-dept.test.js, 7 in team-direct-card.test.js); `npm run lint:gas` clean; module-deps regenerated and the INV-16 guard clean; `npm run ci:ui` all stages passed, with 5 new rendered checks in drive-deptoutbound.js; 7 bite-checks, each named test went red on its mutation. Three print pins failed on the way (they read the first `@media print` block and a new one came first) and were fixed by moving the rule into the existing global print block. Regression scenarios were not walked against the live app; the new steps in S23 (P5) and S67 (follow-ons) are the owner's to walk.
REGRESSION RISKS: (1) Once the column exists, `Other` appears in every department picker (Access Control, Alerts, Exception days, Transfer retries) and as a team in the Direct and Outbound company views; Transfer retries treats it as a department, so a call tried at two people on it reads as a retry there. (2) A column that is really a team but is named exactly `Other` would be off the Overview, coaching and warming with no warning. (3) The card's whole percent and the Direct Calls report's one-decimal figure now differ in precision for the same number. (4) A folded panel hides everything but its header, an error line included; it also prints folded. (5) If Team Rings' own period request fails while the page is still reloading, its frost stays until the page lands.
INVARIANTS AT RISK: None — no public write (INV-01), no cache key or payload rule changed (INV-30; the Overview key already carries the roster hash, so the new column mints new keys by itself), the admin-only strips and gates are untouched (INV-39), `OVERVIEW_HIDDEN_DEPTS` stays Overview-only and `CUSTODIAL_DEPTS` is the wider list.
NET SCORE: 2 − 0 = 2 (P4-F2 and P4-F3 fired in production on every date change and same-department refresh; P5, P4-F1 and P4-F4 are new capability or display and claim no fix)

OPERATOR ACTIONS / DEPLOY:
- Add the `Other` column to `DO NOT EDIT!` (header exactly `Other`, directly after the last department, one blank column left before the insurance block) and list the people on it -- Operator State #93 | BLOCKS DEPLOY: N
- Deploy the dashboard (before or after the column is added; the code is inert until it exists) | BLOCKS DEPLOY: N
- After the column is added: `rebuildDirectCallHeldDates()` (cdr-import) so the held dates credit those people to `Other` | BLOCKS DEPLOY: N
- Walk the new steps in S23 and S67 | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- `Other` still appears in the Direct and Outbound company views, in Transfer retries and in the Dashboard Standards sheet; excluding it there was not in P5's list and each is a separate decision.
- The Queue Call Data panel has its own loading rule and was not given the "busy with the page" frost.
- `cdr-report/queueOverlapAudit.js` reads past the blank header into the insurance block (it skips blank headers instead of stopping at the first); it is a diagnostic, and predates this work.
- The owner's sign-off on the P4 card form is still open; nothing here depends on it.

DOCUMENTATION UPDATES NEEDED:
- None — Operator State #93 and its CLAUDE.md index line, client-ui-conventions (the follow-on rules and the new localStorage key), fix-history (`P4-F`, `P5`), S23 / S67, tests/README, the harness README and module-dependencies were updated in this change.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
