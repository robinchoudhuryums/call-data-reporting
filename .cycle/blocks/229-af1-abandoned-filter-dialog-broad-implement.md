---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: AF-1 (steps 1-2 of the owner-approved Abandoned Filters consolidation plan, 2026-10-05) -- one "Filter abandoned calls…" dialog with a pure core, a single custom-formula native filter, and parity against the fourteen per-queue menu items, which stay on the menu for the owner's side-by-side check (S55).
Files modified: apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/AbandonedFilterDialog.html (new), apps-script/cdr-import/CDR Tools.js, tests/unit/abandoned-filter.test.js (new), tests/README.md, docs/regression-scenarios.md, docs/architecture.md, CLAUDE.md, .cycle/STATE.md

CHANGES:
AF-1 | AbandonedFilter.js | Appended (old engine + 14 wrappers untouched): AF_PRESETS_ (the 14 items' queues + thresholds verbatim, labelled by department; optional backup queues Backup CSR for CSR and A_Q_BackUp_FieldOps for Field Ops), afDefaultThresholds_, afNormalizeSpec_ (validation before anything reaches a formula), afBuildFormula_ (ONE criterion: abandoned AND call time a number AND OR(per-queue arms: queue match + > that queue's threshold [+ whole-second R49 window via dqeWindowStartForQueue_ / DQE_WINDOW_END])), afRowVisible_ (pure mirror -> the dialog's expected count), afTabQueues_, and the dialog entry points showAbandonedFilterDialog / afGetDialogState / afApplyFromDialog / afClearFromDialog.
AF-1 | AbandonedFilterDialog.html | New modal: department preset (ticks its queues), optional backup-queue box, a checklist of every queue on the tab (abandoned counts; preset queues not on the tab greyed), per-queue default thresholds with an optional custom threshold for every ticked queue, a work-window option (off by default), Apply / Clear / Close, and an "expect N of M rows" line. Sheet text written with textContent only.
AF-1 | CDR Tools.js | "Filter abandoned calls…" added at the top of the Abandoned Filters submenu; the fourteen items stay below it until S55 passes.
AF-1 | abandoned-filter.test.js | 10 tests: each preset == its old wrapper's arguments; each preset leaves the old item's rows (the OLD engine run against a recording fake filter whose criteria are interpreted), minus blank-queue legs; backup queues; mixed + custom thresholds; the R49 window; the exact formula; request validation; apply replaces the filter with one criterion; tab queue discovery; the page's server calls + no HTML injection. Bites: a changed preset threshold, a dropped preset queue, a flattened window floor -- all red.
AF-1 | docs | S55 (the side-by-side check), the CLAUDE.md S-index + subsystem list, tests/README map, architecture.md row.

TEST RESULTS: passed -- npm run ci 2186/2186 (TZ=America/Chicago), lint:gas clean (76 files), INV-16 guard in sync. Regression scenarios: S55 is new and owner-run (needs a real tab); no other scenario's subsystem overlaps (CDR Import scenarios S28/S33/S34 cover the import path, which is untouched).
REGRESSION RISKS: (1) The generated formula is evaluated by Sheets, which no test can run -- a divergence between it and the tested mirror would show as the dialog's expected count disagreeing with the tab; S55 checks it. (2) Found while building parity: the OLD engine never hides a blank queue cell, so every old item also shows abandoned legs with a blank queue name; the dialog deliberately leaves them out -- the one expected difference in S55. (3) The window clause parses col C as a Date or "MM/DD/YYYY HH:MM:SS" text; an unreadable cell fails the window (hidden), never passes it.
INVARIANTS AT RISK: None. INV-06/R49: the window takes its floor from dqeWindowStartForQueue_ itself (no new mirror). INV-16/INV-17: untouched / nothing removed.
NET SCORE: 0 production fixes (feature work; the blank-queue difference is unmeasured) − 1 new failure mode (formula vs mirror divergence, documented, surfaced by the expected-count line + S55) = -1

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import, reload the CDR Import workbook, then walk S55 on a recent Call_Legs tab (CSR, Sales, Field Ops, a mixed selection, backup, custom threshold, work window) | BLOCKS DEPLOY: N (blocks step 3, retiring the fourteen items)
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or scripts/deploy.sh apps-script/cdr-import)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- AF-1 step 3 (after S55 passes): remove the fourteen menu items AND their wrapper functions (owner ruling: delete), keep applyAbandonedFilter only if something still calls it; update the parity test to pin the presets on their own.
- AF-1 step 4: the dialog's Transfers mode on transferFilter.js, after the owner confirms the Phase 0 transfer shapes (previewTransferShapes).
- Owner question for S55: whether the blank-queue abandoned legs the old items showed were ever wanted (if so, they belong to no department and would need their own option).
- Ask whether the per-queue thresholds should become editable per queue in the dialog (today: department default or one custom value for all).
DOCUMENTATION UPDATES NEEDED:
- None beyond those made (S55, CLAUDE.md index + subsystem list, tests/README, architecture.md). The CLAUDE.md bullet for the filter is deferred to the end of the rollout (habit 2).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
