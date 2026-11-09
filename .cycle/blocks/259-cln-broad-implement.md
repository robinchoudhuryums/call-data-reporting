---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: CLN-1 (ext grid read A..D -> C..D), CLN-2 (all-dept queue report budget per-run -> slowest-dept projection), CLN-3 (qcd-report.test.js delete-instead-of-restore leak), CLN-4 (IR deptStats.activeDays naming), CLN-5 (bounce diagnostic counted outside parties as unrostered answerers), CLN-6 (Dept Config "default" rows invisible to CDR Import with no hint) -- the carried follow-ons from blocks 179/182-188 plus two from the 2026-11-09 diagnostics review.
New capabilities (G/ST): None
Files modified: apps-script/department-dashboard/{Data.gs, QCDReport.gs, IndividualReport.gs, dashboard.html}; apps-script/cdr-import/transferFilter.js; tests/unit/{dqe-span-readers, qcd-report, individual-report, transfer-filter, dept-config}.test.js; tests/README.md; docs/{fix-history.md, next-steps.md, operator-state.md, module-dependencies.md}

CHANGES:
CLN-1 | Data.gs | `dqeExtGrid_` reads `getRange(2, AGENT, n, 2)` (cols C..D) instead of A..D; `DQE_EXT_GRID_COLS_` = {agent:0, ext:1}; `getDeptQueueExts_(dept, rosterSet, values, cols)` -- `cols` optional, so the full-width callers (Diagnostics, Missed report) are unchanged. Comments updated.
CLN-2 | QCDReport.gs | `computeQcdAllDepartments_` tracks `slowestDeptMs`; the pre-dept check is `elapsed + slowestDeptMs > budget`, still only on a department boundary; 0 until the first dept ends, so dept 1 always runs.
CLN-3 | qcd-report.test.js | REAL_ALLDEPT_ / REAL_LATEST_DATES_ captured at load and put back by `d1Restore_()`; every `delete h.ctx.…` gone; pin that both are back after the D-1 tests.
CLN-4 | IndividualReport.gs | `deptStats.activeDays` -> `deptActiveDays` (both shapes) with a comment against `daysActive`; no client reads `deptStats` (grepped), so no cache bump.
CLN-5 | cdr-import/transferFilter.js | `tfBounceOfJourney_`: an answer named "(...)" or a 7+-digit number -> `outsideParty++`, ignored (not a skipped step); folded, totalled and printed on the per-date / TOTAL line.
CLN-6 | dashboard.html | `#dc-source-note` under the Per-department config table: "default" = built-in, CDR Import cannot see it, Edit and Save to make a sheet row.

TEST RESULTS: `TZ=America/Chicago node --test` 2875 pass / 0 fail; lint:gas clean (80 files); module-deps regenerated, --check up to date; INV-16 guard clean; `CI=1 npm run ci:ui` all stages passed. Bites 8/8: ext grid back to A..D, ext cols ignored, budget projection dropped, IR old name, outside party dropped, note removed, test leak back (plus the R45 path through `cols`).
REGRESSION RISKS: (1) CLN-1 changes the shape of the memoized grid; only `deptQueueExtsFromSheet_` consumes it (grepped), and it passes the new column map. (2) CLN-2 can stop a run ONE department earlier than before when departments are uniform -- partial is still marked, served and never cached (R43), so a near-budget run now returns partial where it used to risk the kill. (3) CLN-5 changes the diagnostic's counts (unrostered answerers fall by the outside-party number) -- log only, no figure.
INVARIANTS AT RISK: INV-53 (the ext set feeds floater recognition) -- unchanged values, pinned by R44/R45 + the full suite; INV-30 (no prefix bump: no cached field changes meaning; `deptActiveDays` is unread). None violated.
NET SCORE: 1 production fix (CLN-2: a slow department could carry the all-dept run past the ceiling) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- In Admin ▾ → Dept Config, Edit + Save each "default" row the pipeline needs (PAP, Spanish, PAK, Billing, Denials); A_Q_Sales_MWC in Sales' Inbound queue aliases (owner ruling XB-0c: "MWC is Sales"); A_Q_BackUp_FieldOps in Field Ops' aliases; then re-run `diagnoseTransferBouncesAllDates` | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` + new version). CDR Import: `cd apps-script/cdr-import && clasp push -f` (CLN-5, diagnostic only).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The other ~20 cut-over readers still have no whole-run budget (carried since block 179; none loops over depts).
- The dashboard's built-in Dept Config defaults (PAP / Spanish / PAK parents, Billing / Denials queues) are invisible to cdr-import by design; a one-click "save all defaults as sheet rows" would remove the manual Edit + Save -- not built.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (fix-history CLN-1..6, next-steps follow-ons struck, Operator State #86 CLN-5/CLN-6, tests/README map).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
