---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- 1a | the unit harness runs under the LIVE timezone split by default (fake spreadsheet -> America/Mexico_City; script zone stays America/Chicago), with two tripwires
- 1b | every bulk sheet repair snapshots the sheet into a standing backup workbook BEFORE its first write (HR_BACKUP_SS_ID, newest 3 per sheet, previews never)
- 2a | Escalations: an ADMIN can permanently delete a mistaken / test escalation (row + activity trail in one transaction; PHI-free usage-row audit; forced outage-snapshot refresh; danger-tone confirm; managers never see the control)
- 2b | the "How is my team doing?" chip runs over the dept controls' window (no 30-day override), rapid re-clicks are seq-guarded, and the onboarding tour waits for the Overview to SETTLE instead of a fixed 1200 ms timer

Files modified:
- tests/harness/fakeSheet.js, tests/harness/shim.js, tests/README.md
- tests/unit/cross-file-pins.test.js, tests/unit/pipeline-build.test.js, tests/unit/historical-date-columns.test.js, tests/unit/sheet-repairs-backup.test.js (NEW), tests/unit/escalations-hardening.test.js, tests/unit/html-include-structure.test.js, + 27 suites that lost an explicit `timeZone: 'America/Chicago'` argument (1a)
- apps-script/cdr-report/sheetRepairs.js
- apps-script/department-dashboard/Escalations.gs, script-10-escalations.html, script-3-overview.html, script-4-nav.html, script-8-insights.html, styles.html
- tools/ui-harness/build-harness.js, drive-admin.js, drive-smoke.js
- CLAUDE.md, docs/operator-state.md (#24c, #59), docs/invariants.md (INV-55), docs/regression-scenarios.md (S45), docs/client-ui-conventions.md, docs/next-steps.md

CHANGES:
1a | tests/harness/fakeSheet.js; 28 suites; cross-file-pins; tests/README | makeFakeSpreadsheet defaults to America/Mexico_City (the live zone); the 89 explicit Chicago fixture args removed (all 1,300 tests passed on the flip -- no fixture relied on the midnights coinciding); pipeline-build + historical-date-columns derive SS_TZ from the default; pins: the fake default is never the shim's script zone AND is the live zone; a Chicago fixture needs `// same-tz: <reason>`; README: fixture dates must be SUMMER dates (winter zones coincide)
1b | sheetRepairs.js; fakeSheet.js; shim.js; sheet-repairs-backup.test.js; Operator State #59; CLAUDE.md bullet | hrBackupBeforeApply_: >= 500 cells -> sheet.copyTo(backup workbook) as `<sheet>|<yyyyMMdd-HHmm>|<label>` (same-minute suffix); workbook created once via SpreadsheetApp.create, id in HR_BACKUP_SS_ID (stale id recreates); prune newest 3 per source sheet via deleteSheet; wired into all five applies (slot timestamps, abandoned ids, PST shift, duplicate merge, date normalize -- which reports the snapshot); fake gains copyTo/setName (+ duplicate-name throw), spreadsheet getId/getUrl/_rename; shim gains SpreadsheetApp.create + strictOpenById
2a | Escalations.gs; script-10-escalations.html; styles.html; build-harness/drive-admin/drive-smoke; escalations-hardening; INV-55; S45; #24 | deleteEscalation: assertAdmin_; DELETE escalation_activity then escalations, one commit, rollback on failure; unknown id -> {deleted:0}; logReportUsage_('escalations:delete', dept) (no id, no PHI) + Logger line; escSnapshotMaybeRefresh_(conn, force=true) after commit; client: admin-rendered `data-admin-only` Delete control on every card, dsConfirm_ danger tone naming id/dept/date; verb mocked in the harness
2b | script-4-nav.html; script-3-overview.html; script-10-escalations.html; script-8-insights.html; html-include-structure; client-ui-conventions | chip label; launcherOpenInsights_ copies from-date/to-date into the Insights inputs (M4 authority) instead of forcing last-30-days; launchSeq_ + 600 ms debounce on chip clicks; onOverviewSettled_/ovMarkSettled_ in script-3 (cache paint, success, failure); initTour_ waits on it (+250 ms) instead of setTimeout 1200

TEST RESULTS: passed -- `node --test` 1316/1316 (1300 + 16 new); INV-16 guard in sync; `npm run ci:ui` run TWICE (after 2a and after 2b): all eight stages green both times (94/16/30/14/52/14/20 checks, exit 0), incl. the five new 2a admin-driver checks and the two smoke-driver role checks. Mutations: 1a 2/2 fire (default -> Chicago fails the pin + six R46 tests; an unexplained Chicago fixture fails the sweep); 1b 5/5 (apply skips backup; prune removed; stale id not recreated; merge writes first; threshold ignored); 2a 5/5 (gate dropped; row before trail; refresh not forced; id leaks into the usage row; unknown id throws); 2b 4/4 (override back; debounce removed; failure handler forgets to settle; timer restored). Regression Scenarios overlapping modified files (S23 tour landing, S40 escalation counts, new S45 admin delete): NOT APPLICABLE here -- manual live-UI walks after the dashboard deploy; the rendered gate covers 2a's open/cancel/confirm and the manager negative.

REGRESSION RISKS:
- 1b: a bulk apply now depends on SpreadsheetApp.create the first time (the `spreadsheets` scope; cdr-report already uses SpreadsheetApp, but if the manifest is auto-scoped the push may prompt once -- Operator State #9). A FAILED copy blocks the apply by design (no snapshot, no rewrite). A 32k-row copy adds seconds to an apply.
- 2a: the delete is irreversible by design (danger-tone confirm); the usage-row audit carries the department only, never the id -- an id-level audit would need its own sheet.
- 2b: the chip now runs over the dept window (default: the latest DQE date, a single day), not 30 days -- a manager who used the chip for a month view now adjusts the dept dates first (owner's decision). If the Overview NEVER settles (a fetch that neither succeeds nor fails), the tour never auto-starts; the old timer would have started it over a skeleton. Deep links off the Overview never auto-start it, as before.
- 1a: none functional (tests only). A contributor running the suite in a non-Chicago process zone has the same assumption as before (process zone == script zone).

INVARIANTS AT RISK: INV-01 / INV-55 -- a NEW public write verb (`deleteEscalation`), admin-gated with the lock + transaction + audit pattern; INV-55's entry updated and pinned. INV-16 untouched (guard clean). INV-30: no cache-key change (the chip now shares the region's key -- fewer keys, not different ones). INV-37: setPage untouched. None violated.

NET SCORE: 2 (1a: the R46 class fired this month and now fails in CI; 2b: the chip's second cache key per click and the skeleton-tour race were live costs) − 2 (1b: a failed backup copy now blocks a repair, by design; 2b: a never-settling Overview never auto-starts the tour) = 0

OPERATOR ACTIONS / DEPLOY:
- After the cdr-report push, if the editor prompts for a new scope on the first bulk apply (SpreadsheetApp.create), consent once (Operator State #9) | BLOCKS DEPLOY: N
- After the dashboard deploy: walk S45 (delete a throwaway escalation as admin; confirm a manager sees no control), S23 with `cdr.tour.done` cleared (the tour starts after the Overview paints), and Help -> "How is my team doing?" (Insights over the dept window) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Manage deployments -> New version (2a + 2b) | CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (1b) | 1a: no deploy

FOLLOW-ON ITEMS:
- No driver clicks a quick-start chip or lets the tour auto-run (every driver sets `cdr.tour.done`); a tour stage would need one boot with the key unset and a settled-Overview assertion.
- Winter-date fixtures cannot expose the TZ split; a sweep flagging Date fixtures dated Nov-Feb is possible but not built.
- 1b has no in-workbook fallback when SpreadsheetApp.create is refused -- the apply throws with the error (documented).
- Carried from the roadmap: Batch 3 (#5 after-hours, 14-day clock) is NEXT; Phase 2 with the memoized TZ-SPLIT check + Health row; the Neon storage decision.

DOCUMENTATION UPDATES NEEDED:
- None outstanding -- made in-batch: CLAUDE.md (1b bullet, 2a write-paths clause, Operator State index #59, regression index S45), docs/operator-state.md (#24c, #59), docs/invariants.md (INV-55), docs/regression-scenarios.md (S45), docs/client-ui-conventions.md (tour gate, 30-day caption), tests/README.md (fixture timezone rule, new suite), docs/next-steps.md (Batches 1-2 shipped, as-built notes).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
