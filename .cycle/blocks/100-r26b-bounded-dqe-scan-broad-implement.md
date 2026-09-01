---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R26b | `sheetFetchDqeRows_` read the ENTIRE DQE Historical Data sheet at full width, twice, to answer a one-day question — the dominant cost of every sheet-path request, charged per department.
Files modified: apps-script/department-dashboard/NeonRead.gs, tests/unit/dal-cutover.test.js

CHANGES:
R26b | apps-script/department-dashboard/NeonRead.gs | `sheetFetchDqeRows_` now scans the DATE COLUMN alone, finds the first and last row whose date falls in range, and reads only that min/max SPAN at full width. Previously it read `lastRow-1 x numCols` twice (getValues for the numerics, getDisplayValues for the INV-02 duration columns) — ~2.2M cell reads on the live 31,545-row sheet, measured at ~48s per call, and the primitive is dept-independent so CSR and Sales for the same day each paid the identical full read. One day now costs a 31.5k-cell date scan plus a ~37k-cell span read. A window with no matching rows returns early and never issues the wide read at all.
R26b | apps-script/department-dashboard/NeonRead.gs | The span is deliberately NOT a tail scan. The sheet is not reliably date-ordered — a backfill appends older dates after newer ones, the same trap that ruled out a tail scan for the CSR transfer read (R25b) — so the span can contain out-of-range rows in the middle. The per-row date filter inside the loop STAYS: the span bounds the read, it does not replace the filter. Output is identical to the full scan for any sheet order.
R26b | tests/unit/dal-cutover.test.js | Five new tests behind an `r26Install()` helper that instruments `getRange` into `sheet._reads`: (1) a one-day window reads a bounded span, not the whole sheet; (2) an empty window issues NO wide read; (3) an out-of-order backfill (older date appended after newer) returns every in-range row; (4) full-scan equivalence — the bounded result deep-equals the unbounded result on a deliberately scrambled sheet; (5) a multi-day window spanning interleaved out-of-range rows.
(incidental) | tests/unit/dal-cutover.test.js | Fixed a pre-existing isolation bug: two tests used `delete h.ctx.sheetFetchDqeRows_`, which strips the property from the vm global permanently and made any later test that calls it fail with "not a function". Now save/restore. Also added the legacy `require('node:assert').deepEqual` — `assert/strict`'s deepEqual rejects cross-realm arrays returned from the vm.

TEST RESULTS: passed — 1119/1119 (`npm run ci`), INV-16 duplication guard clean. Mutation-tested, all four caught: restoring the full-sheet read (1 fail), collapsing the span to the last match / turning it into a tail scan (5 fails), removing the per-row date filter (2 fails), removing the empty-window early-out (1 fail).

REGRESSION RISKS: None identified. `sheetFetchDqeRows_` has nine callers — AgentHome.gs:70, CompanyOverview.gs:485/491/961/964/1613, DqeSilenceWatch.gs:238/240, MissedCallsReport.gs:494, NeonRead.gs:538 (the parity gate). None was touched and none can observe the change: the signature, the returned row shape and the row SET are all unchanged, verified by the full-scan-equivalence test on a scrambled sheet. The one behavioral difference is that an empty window returns `[]` without reading the grid, which was already its return value. The parity gate (`compareDqeSources_`) is the strongest consumer check and reads through this same primitive, so a divergence would surface there as a MISMATCH rather than silently.

INVARIANTS AT RISK: None. INV-02 is preserved — `getDisplayValues()` is still the source for all four duration columns, now over the same narrower range as `getValues()` (both come off ONE `range` object, so the two grids stay index-aligned by construction). INV-10 column positions are untouched. REP-10 is respected — the date-column read is col 1 and the span read keeps the existing `Math.min(HISTORICAL_COLS.QUEUE_SPLIT, sheet.getMaxColumns())` clamp. INV-30 needs no bump: the payload is byte-identical, so no cached value becomes wrong.

NET SCORE: 1 production fix − 0 new failure modes = 1
(The bug fired in production this month: the user's execution log showed `computeSummary_:CSR` at 47,637 ms and `getLatestDataDate` at 36,542 ms on a 108-second page load, with concurrent `getDepartmentSummary` executions each repeating the same full read.)

OPERATOR ACTIONS / DEPLOY:
- Enable report cache warming (Alerts modal → **Report cache warming** → Install, or run `installCacheWarmTrigger()` in the dashboard editor). Complements this fix rather than duplicating it: the bounded read makes each cold aggregation cheaper, warming removes it from the first manager's page load entirely. Operator State #21. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- `getLatestDataDate` measured 36.5s in the same execution log. It already reads one bounded date-column scan (`sheetScanDqeDateBounds_`, F9) memoized per execution, so the cost is the 31.5k-row date column itself on the 5-minute cache tier — a smaller and separate problem from this one, not addressed here.
- Concurrent `getDepartmentSummary` executions each compute independently; there is no request coalescing. Cache warming plus the 6h report TTL is the existing mitigation.
- The nine callers still each pay their own bounded read; no cross-caller memo was added, deliberately — a per-execution memo keyed on (from,to,opts) would help the Overview's repeated YTD reads but changes the negative-cache semantics each caller relies on (the R8-C2 class), so it belongs in its own increment.

DOCUMENTATION UPDATES NEEDED:
- None required. The rule ("bounded span, not a tail scan, because backfills append older dates") is enforced by `dal-cutover.test.js` and documented at the callsite; CLAUDE.md's existing NeonRead bullet already states rule (1) about `json_agg` on the Neon side and needs no counterpart for the sheet side. A `/sync-docs` pass may still choose to name the new tests in the coverage map — `tests/README.md` lists dal-cutover.test.js already.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
