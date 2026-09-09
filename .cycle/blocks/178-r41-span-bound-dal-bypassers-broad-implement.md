---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Phase 1b — apply the R26b bounded-span read to the five DQE readers that bypass the DAL and never adopted it (the finding raised by Phase 1, block 177). Code: R41.
Files modified: apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/InsightsReport.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/NeonRead.gs (comment only), tests/unit/dqe-span-readers.test.js (new), tests/README.md, CLAUDE.md

CHANGES:
R41 | Data.gs | NEW `dqeWindowRowSpan_(sheet, lastRow, fromIso, toIso, ssTZ)` — the R26b transform extracted so all five readers share ONE implementation instead of five copies. Scans the date column alone, returns the `{startRow, numRows}` covering the window, or null when the window is empty (caller then skips the wide read entirely). A min/max SPAN, never a tail scan: the sheet is not reliably date-ordered, so an out-of-order backfill widens the span and can never fall outside it.
R41 | Data.gs | NEW `deptQueueExtsFromSheet_(dept, rosterSet, sheet, lastRow)` — the ALL-HISTORY ext derivation for the sheet path (whole sheet, cols A..D, getValues only). Same split `deptQueueExtsForNeonReader_` already used, minus its Neon-first preference, which would be wrong here: a sheet-path reader is on the sheet precisely because Neon is off or unreachable. Resolves an override BEFORE any read, so an override dept pays nothing.
R41 | Data.gs::computeSummary_ | Sheet branch: full-width whole-sheet `getValues()`+`getDisplayValues()` → span read; ext derivation moved to its own A..D read. This is the reader charged PER DEPARTMENT by combineSummaries_.
R41 | Util.gs::computeActiveAgentsInRange_ | Same transform.
R41 | IndividualReport.gs / InsightsReport.gs | Same transform (structurally identical sites).
R41 | Alerts.gs::alertRowsForDate_ | Span only — no ext derivation here. It asked a ONE-DAY question and read the whole sheet to answer it.
R41 | NeonRead.gs | Comment only: names its inline span as the same computation and says fix-one-fix-both until consolidated. No logic change.
R41 | tests/unit/dqe-span-readers.test.js | NEW suite, 7 pins (below).
R41 | tests/README.md, CLAUDE.md | Coverage map entry; the span bullet's "five readers still bypass" paragraph replaced (it is now false) with the R41 rule + the all-history trap.

THE TRAP THIS FIX TURNED ON: four of the five ALSO derive `deptQueueExts` from the same bulk grid, and that derivation needs every extension a roster agent has EVER used, not the window's (getDeptQueueExts_ docstring). A naive span would silently SHRINK that set, changing which floaters are recognized — a behavior change wearing an optimization's clothes, and one that leaves every pre-existing test green. Found before writing code, by reading the callers rather than the call sites.

TEST RESULTS: passed. `npm run ci` 1252 pass / 0 fail; INV-16 guard clean. `npm run ci:ui` skips cleanly (playwright not installed locally).

New pins, each mutation-tested — a green suite proves nothing until each assertion is shown to fire:
| mutation | pin that fired |
|---|---|
| span → tail scan | out-of-order rows; span-vs-full-scan equivalence |
| span start off-by-one | 5 of 7 |
| span numRows short by one | 5 of 7 |
| empty window returns the whole sheet | wide-read count (0 expected) |
| ext derivation fed one row instead of all history | ALL-HISTORY floater pin |
| ext helper reuses the Neon-first path | ALL-HISTORY floater pin |
| Alerts' per-row date filter removed | single-day read |

TWO MUTATIONS THAT COULD NOT FIRE, AND WHY (measured, not assumed): removing the read-side date filter in `computeSummary_` or in IR leaves the suite green — computeSummary_ re-checks from/to and priorFrom/priorTo inside its aggregation loop, and IR's trend buckets against a fixed 12-month month-key list. In both the read filter is defense-in-depth. The alert engine is the ONE reader with no second gate, and that is where the filter is pinned. Recorded in the suite rather than papered over with a fixture contortion; an assertion that cannot fail is worse than none.

REGRESSION RISKS:
- `meta.rowsScanned` (Data.gs) is derived from `lastRow`, NOT from the grid length — checked; unchanged by the span.
- No other output is grid-size-derived; every other `values.length` is a loop bound.
- Payload equality across row orderings is pinned directly (span-vs-full-scan equivalence test).
- `deptQueueExtsSource` still reports 'override'/'derived' identically.
- Cache versions deliberately NOT bumped: no aggregation rule changed and outputs are pinned identical, so a bump would only discard warm entries.
- Residual: `sheetFetchDqeRows_` (NeonRead.gs) still carries its own inline span — two implementations of one computation. Flagged in-code and in CLAUDE.md; consolidation left as a follow-on rather than widening this change.

INVARIANTS AT RISK: None.
- INV-02 (durations via getDisplayValues) — the span read still takes both grids; only the row range narrowed.
- INV-53 (floater exclusion) — the ext derivation is the mechanism behind it, and keeping it all-history is the change's central pin.
- INV-04 / INV-23 / INV-05 — untouched; the aggregation loops are byte-identical.
- INV-30 — no cache-prefix bump needed (no aggregation-rule change).
- INV-01 — both new helpers are `_`-suffixed, so RPC-unreachable.
- REP-10 — no new `getRange` past `getMaxColumns`; every call reuses the caller's already-clamped width.

NET SCORE: 1 production fix − 0 new failure modes = 1
(a) Would it have fired in production this month? YES — the sheet path is the DEFAULT read source, and computeSummary_ was charged per department, so every combined-view load paid an N× whole-sheet read at full width, twice over.
(b) New failure mode introduced? NO — the all-history ext derivation is preserved and pinned; the equivalence test pins payload identity.

OPERATOR ACTIONS / DEPLOY:
- None (no Script Properties, no triggers, no migrations). | BLOCKS DEPLOY: N
- After deploying, run `runLiveSmoke` (System Health) — the standard post-deploy sweep for live wiring. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`).

REGRESSION SCENARIOS: NOT RUN — every scenario touching these readers is manual and needs a live deploy, which is not available in this session. The operator should walk, in priority order: **S6** (Source column + roster-only totals) and **S35** (Phase D totals parity) and **S13** (IR agent picker active/inactive/floater grouping) — these three exercise the floater/ext derivation, the only place this change could alter behavior; then S1, S2, S11, S14, S20 as normal coverage.

FOLLOW-ON ITEMS:
- Consolidate `sheetFetchDqeRows_`'s inline span into `dqeWindowRowSpan_` so there is genuinely one implementation. Deliberately out of scope here (a 6th reader, its own review surface); a drift note sits in NeonRead.gs and CLAUDE.md meanwhile.
- Phase 2 of the Neon-outage plan (per-caller failure policy + whole-run time budget) remains unstarted.
- Measurement: the `[dqe-read]` lines now report far smaller reads on the sheet path. Worth reading one live morning's log to size the actual saving rather than asserting it.

DOCUMENTATION UPDATES NEEDED: None outstanding — CLAUDE.md's span bullet and tests/README.md were updated in this commit (the bullet's previous "five readers still bypass … a known gap" text was made false by this change and has been replaced).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
