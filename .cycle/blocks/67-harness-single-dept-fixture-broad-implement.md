---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: **Harness fixture for a department with no sub-queues**, restoring the single-dept render + CSV assertions that lapsed when the scope switcher was retired. **It immediately surfaced a live production bug: the header department selector threw and did nothing for every admin.**

Files modified:
- tools/ui-harness/gen-payloads.js (`summary-30d-sales`)
- tools/ui-harness/build-harness.js (dept-aware `getDepartmentSummary` stub)
- tools/ui-harness/drive-subqueue.js (+6 assertions)
- apps-script/department-dashboard/script.html (**the dept-switch fix — a production change**)
- CLAUDE.md, docs/regression-scenarios.md (S43)

CHANGES:
Fixture | gen-payloads.js | `summary-30d-sales` — a dept with NO sub-queues. **No fixture DATA change was needed**, which is worth knowing before anyone adds agents for this: Sales's seeded child in `OVERVIEW_PARENT_OF` is `PAP`, which is absent from this roster, and `subQueueChildMap_` drops an edge naming a dept that does not exist. So Sales already renders exactly like the 11 of 14 real departments that never had a sub-queue, while still having agents and data. Adding a Billing profile (the other candidate) would have changed the company Overview payload for every other driver.
Fixture | build-harness.js | The stub dispatches on `req.department` BEFORE the window branches — the department decides this payload's shape, not the range. The `subScope` branches stay even though the client no longer sends one: the server still honors the parameter, and a stub that quietly stopped serving those payloads would hide a regression in a path that still exists.
Coverage | drive-subqueue.js | Restored: a sub-queue-less dept renders no relationship bar, no group headers, no per-dept subtotals, but still renders agents and a totals row; its CSV has **no** leading `Department` column and no subtotal/`All shown` rows. That last one is the byte-compatibility promise made to every department that never had a sub-queue — the common case, and the one with the most to lose.
**BUG (production)** | script.html | `selectOption('#dept-selector', 'Sales')` threw `ReferenceError: prLastRoster is not defined`. The change handler still cleared `prLastRoster` and `crLastRoster`, roster caches belonging to the **Performance and Compare Ranges reports, retired and deleted long ago**. `script.html` is `'use strict'`, so assigning to an undeclared identifier throws — and the throw landed on the line *before* `refresh()`. **The department selector silently did nothing for every admin and every multi-dept manager.** Fixed by deleting the two dead assignments.
Guard | drive-subqueue.js | The switch itself is now asserted two ways: that it does not throw, and that the table's row count actually CHANGED (CSR 7 → Sales 4). A no-throw check alone would still pass if the handler ran but the refresh never landed.

TEST RESULTS: passed. `npm run ci` → **590/590**. `npm run ci:ui` → **24/24 + 16/16 + 31/31** (was 24). INV-16, cache-version-sync, claude-md-split clean.
**Both the bug and the restored assertions were verified by breaking them**: restoring one `prLastRoster` line fails the new guard with the exact production error and leaves Sales showing CSR's 7 rows; the single-dept CSV check fails against the combined payload.
Regression Scenarios: NOT EXECUTED. **S2 (admin switches departments) is the one that matters here and now genuinely needs a live walk** — it is the scenario that should have caught this and evidently was not being run. S43 also overlaps.

REGRESSION RISKS:
- **The dept-switch fix is a production change inside a fixture-scoped increment.** It is two deleted lines assigning to variables that do not exist, so there is nothing it can break — but it is not test-only work and should be read as a behavior fix.
- **The stub now returns the Sales payload for ANY department that is not CSR.** Fine for a fixture with five depts, but a future driver asking for Power or Billing gets Sales's numbers. It is a stub, not a server; noted so nobody reads a dept name off it and trusts it.
- The driver leaves the selector on CSR when finished, so later assertions in the same run are unaffected — but the walk is now order-dependent in a way it was not before.
- No server-side or pipeline file changed beyond the two deleted lines. No cache key, payload shape or auth path moved.

INVARIANTS AT RISK: None violated.
- **INV-30** — no cache key or version touched.
- **INV-37** — no page/route change; the selector's behavior is restored, not altered.
- **INV-53 / S35** — untouched; the new assertions are about a dept with no sub-queue at all, where the floater and parity rules are unchanged.

NET SCORE: 1 − 0 = 1
- One real production bug fixed, and it was firing continuously: no admin could change departments from the header. It is not a rare edge — it is the primary control on the page for admins.
- No new failure mode; the fix removes code rather than adding it.

OPERATOR ACTIONS / DEPLOY:
- **Confirm the department selector works after deploy** — pick another department and check the table actually changes. This is S2, and its lapse is the reason the bug survived. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + a new deployment version (script.html).
- No other subsystem touched; the harness files are not deployed.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Nothing else in the client references a retired report's state** — checked while fixing: `prLastRoster` / `crLastRoster` appeared at exactly those two lines. Other retired-report orphans are documented cache keys and localStorage keys, which are inert.
- **The gate has never exercised several other header controls** (view-as-manager, the theme/mode toggles, the Export dropdown outside the CSV item). The dept selector's bug is an argument that any control with no automated interaction is a candidate for the same class of failure.
- The `ui-harness` CI job still carries `continue-on-error: true`, so all 31 of these assertions remain advisory. This increment is a concrete argument for dropping that line.
- Phase 3 (Missed) and Phase 4 (IR / Insights) remain all-queue; the Insights combined view is still unstarted.

DOCUMENTATION UPDATES NEEDED: None outstanding — done inline. CLAUDE.md's driver description now names the single-dept CSV and the department switch; S43's single-dept step is re-automated and its closing note corrected to say what remains manual.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
