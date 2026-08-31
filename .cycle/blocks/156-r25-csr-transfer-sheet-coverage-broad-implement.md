---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-09 owner questions #3 then #2)
- #3 — CSR transfer DETAIL: the per-AGENT rows and 11 per-QUEUE destination columns `CSR Transfer Historical Data` has always carried (INV-52) but the dashboard never read. Server now surfaces `agents` / `queues` / `daily` / `queueSum` / `queueUnaccounted`; a folded CSR-only "Transfer detail" section renders destinations + who transfers, with the R23 tier tint shared with the headline tile.
- #2 — SHEET coverage check (`SheetCoverage.gs::runSheetCoverageCheck`): flags BUSINESS DAYS with zero rows in each dashboard-read historical sheet (DQE / QCD / Direct Call History), holiday-aware and floored at each sheet's first date. Closes the interior-gap blind spot: freshness watches the trailing edge, DQE-silence is per-dept, a run that never happened writes no Pipeline Health row, and runNeonCoverageCheck compares the two SIDES — so a date missing from BOTH was invisible. Opens NO Neon connection (usable mid-outage) and reuses the Neon check's pure gap primitives.

Files modified: department-dashboard/{Config.gs, Data.gs, SystemHealth.gs, SheetCoverage.gs (new), dashboard.html, script-5-dept.html, styles.html}, tests/unit/{csr-transfer-detail.test.js (new), sheet-coverage.test.js (new)}, tests/README.md, CLAUDE.md, docs/{invariants.md, operator-state.md, known-issues.md, conventions.md, architecture.md, client-ui-conventions.md}

CHANGES:
#3 | Data.gs | computeCsrTransferRange_ widened 7 -> 18 cols; per-agent / per-destination / per-day aggregation; headline fields computed exactly as before; summary:v20 -> v21
#3 | Config.gs | CSR_TRANSFER_COLS_ / _QUEUE_FIRST_COL_ / _QUEUE_COUNT_ layout constants
#3 | dashboard.html + script-5-dept.html + styles.html | folded CSR-only "Transfer detail" section, bar rows, R23-shared tier tint, unaccounted-transfers disclosure
#2 | SheetCoverage.gs | runSheetCoverageCheck + pure sheetCoverageAssess_ + OPS-8 outcome recording + findings-only admin email
#2 | SystemHealth.gs | "Sheet coverage — last check" row
#2 | Config.gs | SHEET_COVERAGE_DAYS (operator) + SHEET_COVERAGE_LAST/_LAST_RESULT (engine) registered in PROP_REGISTRY_

TEST RESULTS: 1016/1016 pass (+17: 7 csr-transfer-detail, 10 sheet-coverage). INV-16 guard green; cache-version-sync green after the v21 sync across 8 docs; claude-md-split green (the System Health bullet was trimmed back under the 4096B ratchet after the addition pushed it over). ci:ui skips locally (no playwright); the client changes ride the blocking CI ui-harness job.
REGRESSION RISKS: (1) `summary:v21` invalidates every cached My Department payload — one cold recompute per (dept,range) after deploy, by design. (2) computeCsrTransferRange_ now reads 18 cols instead of 7 over the same full-sheet range (~2.5x cells on a CSR-only sheet); unchanged read PATTERN, no tail-scan regression introduced. (3) The detail section renders only when the server ships the new arrays, so an older cached payload degrades to the pre-existing tile with no empty shell. (4) Per-agent rows are deliberately NOT roster-filtered — they must sum to the headline (reconciliation); a departed agent shows with historical volume.
INVARIANTS AT RISK: None. INV-52 read-only (schema unchanged); INV-30/INV-09 honored via the v21 bump + doc sync; INV-01 clean (both additions are read-only; runSheetCoverageCheck is admin-gated and writes only its own outcome properties); INV-04 not involved (the CSR sheet is CSR-scoped and the headline was already unfiltered).
NET SCORE: 2 − 0 = 2 (#2 closes a silent data-loss class that can fire any month an import is skipped; #3 surfaces already-captured data with no pipeline change).

OPERATOR ACTIONS / DEPLOY:
- Run `runSheetCoverageCheck()` once from the dashboard editor after deploy to establish a baseline, then monthly / after any known import trouble. Optional `SHEET_COVERAGE_DAYS` (default 30). | BLOCKS DEPLOY: N
- Nothing to configure for the CSR transfer detail — it reads columns the pipeline already writes. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (id now read from .deployment-id)

FOLLOW-ON ITEMS:
- computeCsrTransferRange_ still does a FULL-sheet read (pre-existing); a widening tail scan like the export tabs would bound it as the sheet grows. Out of scope here — the read pattern was not changed, only its width.
- #1 from the same discussion (a UI route to add a department) was assessed and NOT implemented: a dept is a roster COLUMN whose block ends at the first blank, so a public write path there risks truncating the dept list for everyone. The recommended alternative — a read-only "new department" checklist in the Dept Config modal — remains unbuilt.
- The sheet coverage check is editor-run only; a weekly trigger (the PipelineWatch pattern) would make it proactive rather than remembered.
DOCUMENTATION UPDATES NEEDED:
- None outstanding — CLAUDE.md (System Health bullet + Subsystems + Operator State index), docs/operator-state.md #52, and the INV-30 v21 entry were updated in this increment.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
