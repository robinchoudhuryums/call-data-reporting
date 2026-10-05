---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: AF-1 follow-up (owner, 2026-10-05) -- no exclusion the old items lacked, plus a diagnostic that checks the dialog against the old items on a real tab.
Files modified: apps-script/cdr-import/AbandonedFilter.js, apps-script/cdr-import/AbandonedFilterDialog.html, apps-script/cdr-import/CDR Tools.js, tests/unit/abandoned-filter.test.js, tests/README.md, docs/regression-scenarios.md, .cycle/STATE.md

CHANGES:
AF-1 | AbandonedFilter.js | The old engine never hides an EMPTY queue cell (its hidden-values list skips blanks), so its items show abandoned legs with no queue name; the dialog now includes them by default (spec.includeBlankQueue, held to the lowest ticked threshold, the standard window floor), making parity exact. afApplySpec_ shared by the dialog and the check. New check: afCheckPlan_ (14 presets vs their old items + 5 dialog-only shapes), afCheckRows_ (every abandoned leg + an even sample of the rest), afRunCheck_ (applies each filter, reads Sheet.isRowHiddenByFilter, compares OLD vs NEW and NEW vs the tested rule, clears the filter, 4.5-min budget), afCheckReportLines_ (CLEAN / MISMATCH naming each row / INCONCLUSIVE), runAbandonedFilterCheck (menu, confirms first).
AF-1 | AbandonedFilterDialog.html | "Include legs with no queue name" box, ticked by default.
AF-1 | CDR Tools.js | "Check the dialog against the old items (this tab)…" in the Abandoned Filters submenu.
AF-1 | abandoned-filter.test.js | 15 tests: exact parity (old engine vs tested rule vs the generated FORMULA, evaluated by an independent recursive-descent evaluator with Sheets' comparison/error rules); the no-queue-name option; window edges to the second; the check end to end on a fake whose isRowHiddenByFilter evaluates the real criteria (CLEAN, a forced MISMATCH naming the row, INCONCLUSIVE on budget). Bites: dropping the no-queue-name arm (formula or rule), leaving the filter on, an off-by-one window, skipping the old-item comparison -- all red.

TEST RESULTS: passed -- npm run ci 2191/2191 (TZ=America/Chicago), lint:gas clean.
REGRESSION RISKS: The check REPLACES the tab's filter and leaves it cleared (it says so before running). isRowHiddenByFilter is one call per row read; the budget stops cleanly (INCONCLUSIVE) on a very large tab.
INVARIANTS AT RISK: None.
NET SCORE: 1 production fix (the dialog would have hidden no-queue-name legs the old items show) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import, then run the check on two Call_Legs tabs and walk S55 | BLOCKS DEPLOY: N (blocks retiring the fourteen items)
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- AF-1 step 3 after a CLEAN check + S55: retire the fourteen items and wrappers; keep the check until then.
- AF-1 step 4: Transfers mode, after the Phase 0 transfer shapes are confirmed.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
