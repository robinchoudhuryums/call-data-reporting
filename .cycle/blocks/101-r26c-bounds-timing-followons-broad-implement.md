---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: R26c | `getLatestDataDate`'s 36.5s sheet path could not be attributed — the bounds scan now splits its own cost between opening the workbook and reading the date column. (Follow-on 2, request coalescing: ASSESSED AND DELIBERATELY NOT FIXED — reasoning below. Follow-on 3, the cross-caller memo, was excluded by the owner.)
Files modified: apps-script/department-dashboard/Data.gs, tests/unit/dal-cutover.test.js

CHANGES:
R26c | `Data.gs` | `sheetScanDqeDateBounds_` now times the workbook open and the date-column read SEPARATELY and emits one `[dqe-read] dqeDateBounds source=sheet rows=N openMs=N scanMs=N` line, under the existing `logDqeReadTiming_` prefix so it lands beside the read-timing lines already there. New `logDqeBoundsTiming_` helper, try/catch-wrapped by that function's contract — a timing line must never break the read it measures.
R26c | `Data.gs` | The log sits AFTER the memo check, so the three-plus callers in one execution produce one line, not three. A per-call line would misreport the cost as multiples of what was actually paid.
R26c | `dal-cutover.test.js` | Three tests: both halves are labelled and passed as separate numeric args (a single combined `ms` fails — that is the measurement that already existed and could not answer the question); a THROWING Logger cannot break the scan; the line is emitted once per execution, not once per caller.

WHY INSTRUMENTATION AND NOT A FIX — this is the finding, not a hedge:
The 36.5s is the whole of `getLatestDataDate`'s sheet path, and there are two candidate causes with OPPOSITE fixes.
  (a) The 31.5k-row date-column read. Fix = bound the scan (the R26b/R25b shape).
  (b) `openSpreadsheet_()`, which is a bare unmemoized `SpreadsheetApp.openById()` — **83 callsites across 26 files** in the dashboard project, several of which fire in a single `getDepartmentSummary` request (Auth.gs 7, Alerts.gs 11, OrphanFix.gs 10, Data.gs 5, NeonRead.gs 3, Util.gs 2 …). On a workbook this size the open is not free and is paid again every time. Fix = memoize the handle per execution.
Picking wrong costs a wide-blast-radius change for nothing, and (b)'s fix is genuinely wide: 20+ suites already hand-reset per-execution memos, the harness has no central install hook to reset a new one, and a suite that FORGETS gets a silently stale fixture — the exact trap CLAUDE.md documents for `DQE_DATE_BOUNDS_MEMO_`. Per the "stop if a fix is more complex than expected" rule, this increment ships the measurement that makes the choice answerable instead of the guess. One slow morning now names the half.

FOLLOW-ON 2 — REQUEST COALESCING: ASSESSED, NOT FIXED (deliberate).
Concurrent `getDepartmentSummary` executions each compute independently; there is no stampede protection. The obvious implementation is a `LockService` gate so the second request waits and then takes the cache hit. Rejected on repo-specific grounds: a waiter that blocks behind a slow first execution can hit the 6-minute Apps Script ceiling, and **that kill SKIPS catch blocks** — the documented failure class that once ate a Daily Queue Report day (CLAUDE.md, "the hanging-connect problem"). Trading independent slow requests for a serialized one that can die past its own error handling is a worse failure mode than the one it fixes. The supported mitigations are the ones already in place: the 6h report TTL with the freshness-tag anchor, and cache warming (Operator State #21) — plus R26b, which cut the per-request cost that makes concurrency hurt. Revisit only with a mechanism that cannot outlive the execution ceiling.

TEST RESULTS: passed — 1122/1122 (`npm run ci`), INV-16 guard clean. Mutation-tested, all three caught: collapsing the split into one combined `ms` (1 fail), moving the log above the memo check so it fires per caller (1 fail), removing the try/catch (1 fail).

REGRESSION RISKS: None. `sheetScanDqeDateBounds_`'s return value, memo semantics and callers (`getLatestDataDate`, `getLatestDataDates`) are untouched; the only additions are two `Date.now()` reads and a wrapped Logger call on the path that was already about to do a 31.5k-row read. The R8-C2 negative-cache semantics each caller owns are unchanged — the helper still does not cache across requests.

INVARIANTS AT RISK: None. No aggregation rule, cache key, column position or read source changed, so no INV-30 bump. INV-01 holds — `logDqeBoundsTiming_` is `_`-suffixed and RPC-unreachable, and writes nothing.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(Correctly zero: this increment buys a measurement, not a behavior change. Neither follow-on was a bug that fired — one was an unattributed cost, the other a design gap whose fix would be worse than the gap.)

OPERATOR ACTIONS / DEPLOY:
- After the next slow My Department load, read the execution log for `[dqe-read] dqeDateBounds` and note which of `openMs` / `scanMs` dominates. That single line decides the next increment: a bounded scan, or the `openSpreadsheet_` memo. | BLOCKS DEPLOY: N
- Enable report cache warming if not yet done (Alerts modal → Report cache warming → Install). Operator State #21. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`).

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **`openSpreadsheet_()` memoization (83 callsites, 26 files)** — the strongest remaining perf candidate, held pending the `openMs` reading above. If taken: `var` memo keyed on the resolved spreadsheet id (so an id change re-opens), and the test blast radius must be handled centrally in the harness rather than by editing 20+ suites, or the next suite to forget a reset gets a silently stale fixture.
- `getLatestDataDates` runs its own whole-column scan of `QCD Historical Data` (same cost class as the DQE one, on the 5-min tier). Not touched here; if `scanMs` turns out to dominate, this is the sibling to bound in the same pass.
- Cross-caller memo for `sheetFetchDqeRows_` — excluded by the owner, and still carries the R8-C2 negative-cache concern noted in block 100.

DOCUMENTATION UPDATES NEEDED:
- None. The rule is enforced by `dal-cutover.test.js` and the reasoning lives at the callsite; nothing in CLAUDE.md becomes false.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
