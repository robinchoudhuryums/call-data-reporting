---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: INV-06 seam — extend the work-window parity pin to the two copies it did not cover (the DQE drill-down's own constants; the CST half of the dashboard display mirror), and correct the docs that claimed the seam was unenforced.
Files modified: tests/unit/cross-file-pins.test.js, docs/invariants.md, docs/module-dependencies.md, CLAUDE.md

CHANGES:
INV-06 | tests/unit/cross-file-pins.test.js | Hoisted the pipeline-constant extraction into `pipelineWindow_()` (now also reads `DQE_PST_TO_CST`) plus a guarded `windowSecs_()` evaluator that fails with the constant's NAME when a RHS stops being plain arithmetic. Extended the existing `S1/INV-06` test to derive and assert `DASHBOARD_WORK_WINDOW.cst` (= PST window + DQE_PST_TO_CST); previously only `.pst` was checked. Added a second test pinning `DQE_DD_WINDOW_START/END` in cdr-report/DQEdrilldown.js against the pipeline.
INV-06 | docs/invariants.md | Rewrote the INV-06 entry: names the pipeline constants as the SOURCE OF TRUTH, enumerates all THREE mirrors (display strings both zones, inbound SQL strings, the drill-down's copy), records the half-open `[start, end)` shape, and names the enforcing test (the C2 corollary the entry was missing). Notes the cdr-report pipeline copy is INV-16's concern, not this one.
INV-06 | CLAUDE.md | INV-06 index line now says the pipeline constants are the source of truth, that three mirrors must agree, and names `cross-file-pins.test.js`.
INV-06 | docs/module-dependencies.md | CORRECTION. The seams diagram and table asserted INV-06 was "the one seam with NO enforcement — prose only". That was false when written: the `S1/INV-06` pin has existed since the 2026-08-27 broad scan and tests/README.md already listed it. Both places now name the test and the four copies.

TEST RESULTS: passed — `npm run ci` green: 1232 tests (was 1231; +1 new test), 0 fail, plus the INV-16 duplicated-files guard clean. Each new assertion was mutation-verified rather than assumed: drill-down END 15h→16h fails; dashboard CST 8:30→9:30 fails; moving the pipeline START 6:30→7:00 fails BOTH tests (every mirror follows the source of truth). A non-arithmetic RHS was also injected to confirm the guard reports the constant name instead of a bare ReferenceError.

REGRESSION RISKS: None to production — no production code was changed; the diff is one test file and three docs. The residual risk is confined to CI: the pins are source-regex tripwires, so reformatting a pinned constant (multiline, or a computed RHS) fails the suite until the pin is reworked. That is the intended behavior of this suite's whole class of pin, and every such failure now names the constant and says what to do.

INVARIANTS AT RISK: None. INV-06 is strictly better enforced than before (2 copies pinned → 4). INV-16 untouched and its guard re-run clean; the cdr-report copy of buildDQEHistoricalData.js is deliberately NOT pinned here because byte-identity is INV-16's job — pinning it twice would create a second place to update. The claude-md-split index↔file parity check passes over the edited INV-06 entry (ID and Subsystem unchanged, as that test requires). CLAUDE.md 168.8 KB, 31.2 KB headroom.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(a) Would this have fired in production this month? NO — the four copies were in fact in sync; this closes the path by which they could silently diverge, and the DQE drill-down is the copy CLAUDE.md records as having drifted three times.
(b) New failure mode introduced? NO.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: N/A — no deployable code changed. The modified files are a test and three documents; no Apps Script project's shipped source is affected, so no `clasp push` is required for this change.

FOLLOW-ON ITEMS:
- The DQE drill-down's half-open BOUNDARY OPERATORS are still unpinned. The pipeline uses `startPST >= START && startPST < END`; the drill uses the negation `startPST < START || startPST >= END`. The constants are now pinned but an inverted or inclusive comparison would not be caught by these pins — only incidentally by dqe-drilldown-parity's fixture, and only where a leg sits exactly on a boundary. Deliberately left: pinning operator shape over-fits to current code layout, and the behavioral parity suite is the better home if it is worth closing.
- INV-18 (missed-calls chart, 8 AM–5 PM CST, 18 half-hour buckets) and `INBOUND_HEATMAP_WINDOW_START_HOUR/END_HOUR` are a SEPARATE window family that partially coincides with INV-06's CST end. Not touched, and deliberately not folded into these pins — conflating two invariants that happen to share an edge is how a future change to one silently breaks the other.

DOCUMENTATION UPDATES NEEDED:
- Done in this session (docs/invariants.md, CLAUDE.md, docs/module-dependencies.md). No further doc work outstanding for this finding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
