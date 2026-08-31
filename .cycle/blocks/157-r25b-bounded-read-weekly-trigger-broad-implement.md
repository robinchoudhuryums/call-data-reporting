---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (R25b — the two follow-ons logged by increment 156)
- computeCsrTransferRange_ follow-on — the widened A..R read was still a FULL-sheet scan on every CSR My Department load. Now bounded: one narrow date-column pass finds the first/last row in the window, then only that row SPAN is read at full width.
- Coverage-check weekly trigger — runSheetCoverageCheck was editor-run only, i.e. it depended on someone remembering to look for a gap that by definition produces no other signal. Now a flag-gated weekly engine (Mondays ~7 AM), silent on a clean week.

Files modified: department-dashboard/{Config.gs, Data.gs, SheetCoverage.gs, SystemHealth.gs}, tests/unit/{csr-transfer-detail.test.js, sheet-coverage.test.js}, CLAUDE.md, docs/operator-state.md

CHANGES:
R25b-1 | Data.gs + Config.gs | bounded-span read (narrow date scan -> wide read of the window span only) + CSR_TRANSFER_DATE_COL_. Deliberately NOT the export tabs' widening TAIL scan: those sheets are kept sorted by their own exporter, while this one is APPEND-ONLY and never sorted (cdr-import appends at getLastRow()+1 on both the daily and bulk paths), so a tail scan would silently drop backfilled older dates — quietly wrong numbers, strictly worse than slow. The span approach is correct at any row order.
R25b-2 | SheetCoverage.gs | runSheetCoverageWeekly_ (flag-gated on SHEET_COVERAGE_ENABLED, never throws to the trigger runner), install/uninstallSheetCoverageTrigger (admin-gated, fully reversible), getSheetCoverageStatus_
R25b-2 | SystemHealth.gs | trigger-readiness row registered WITH its flagProp, so installed-but-disabled is flagged rather than reported as armed (the install-readiness rule)
R25b-2 | Config.gs | SHEET_COVERAGE_ENABLED registered in PROP_REGISTRY_ (operator)

TEST RESULTS: 1023/1023 pass (+7: 3 pinning the bounded read — boundedness, OUT-OF-ORDER rows still counted, empty window costs no wide read; 4 pinning the trigger — flag-off no-op, flag-on run, throwing check recorded not re-thrown, install/uninstall reversible + admin-gated). INV-16 guard green; claude-md-split green after trimming the System Health bullet back under the 4096B ratchet (the engine-count edit put it 1 byte over). ci:ui skips locally (no playwright).
REGRESSION RISKS: (1) The bounded read changes WHICH rows are fetched, not which are counted — the in-loop date filter is unchanged, and the out-of-order test pins that no row reachable before is dropped now. (2) An empty window now returns null BEFORE the wide read; the old code reached the same null via totalCalls<=0, so the contract is identical. (3) The weekly trigger adds no behavior when unarmed (flag default absent = off), and its handler swallows errors by design so a failing check cannot silently uninstall itself.
INVARIANTS AT RISK: None. INV-52 read-only (schema untouched); INV-30 unaffected (no payload shape change, so no cache bump); INV-01 clean (the trigger's entry points are assertAdmin_-gated and write only their own flag/outcome properties).
NET SCORE: 2 − 0 = 2 (the read runs on every CSR dept load; the trigger converts a remembered chore into a control).

OPERATOR ACTIONS / DEPLOY:
- Run `installSheetCoverageTrigger()` once from the dashboard editor to arm the weekly scan (Operator State #52). A clean week sends nothing. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .`

FOLLOW-ON ITEMS:
- CLAUDE.md is at ~191KB against the 200KB cap and BOTH increments in this branch needed the System Health bullet trimmed to fit. A relocation pass (the F8/F8b pattern) is now the prerequisite for the next feature, not a nicety.
DOCUMENTATION UPDATES NEEDED:
- None outstanding — Operator State #52 gained the trigger instructions, the index line and the seven-engine readiness count were updated in this increment.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
