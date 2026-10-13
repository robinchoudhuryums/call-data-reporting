---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- DATA-6 -- the two caches that embed queue data (`summary`, `insights`) were anchored on the DQE date only; their keys now also carry the latest QCD date
- DATA-7 -- the combined sub-queue view computed every child's QCD snapshot and CSR transfer block and threw them away; only the requested dept computes them now, and CSR's two transfer calls share one date-column read
- DATA-8 -- latent (`QUEUE_SPLIT_SCOPE=dept` only): a crossover agent narrowed in one dept and all-queue in another (that dept fell open under B-1) was double-counted in the combined total
Files modified:
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/Util.gs
- apps-script/department-dashboard/InsightsReport.gs
- tests/unit/queue-split.test.js, subqueue-access.test.js, compute-summary.test.js, csr-transfer-detail.test.js, cache-key.test.js
- CLAUDE.md (one sentence), docs/invariants.md (INV-30), docs/module-dependencies.md (regenerated), docs/next-steps.md

CHANGES:
DATA-6 | Util.gs, Data.gs, InsightsReport.gs | New qcdFreshnessTag_() (Util.gs, beside reportFreshnessTag_) returns the latest QCD date through the existing D-1 anchor qcdAllFreshnessAnchor_, which carries its trigger-context fallback; 'na' on any failure or when QCDReport.gs is not loaded. The `summary:v23` key and the `insights:v24` key each gain `':q' + qcdFreshnessTag_()`. It is a suffix, not a version bump (the CORE-3 pattern), and rosterHash stays last, so DL-5's pin is unchanged.
DATA-7 | Data.gs | computeSummary_ gains `opts.sections === false`, which skips computeDeptQcdSnapshot_ and computeCsrTransferRange_ (qcd/csrTransfer null; rows, totals and meta unchanged). getDepartmentSummary passes `{ sections: d === dept }` to each part. The 'subs' scope's separately computed primary keeps the default. computeCsrTransferRange_ takes an optional call-scoped `ctx` that shares the date column between computeSummary_'s current and prior calls (keyed on lastRow). It is deliberately not a cross-call memo, so there is no staleness across requests or tests. Side effect, as the scan noted: a child's QCD/CSR read failure no longer blocks caching a payload that never shipped it.
DATA-8 | Data.gs | combineSummaries_ pre-scans for scoped roster rows and, per agent, an un-scoped roster row from a part whose meta.queueSplitFellOpen is true (the B-1 whole-window rollback, all-queue on every day). Each scoped slice of an agent that has such a superset row is subtracted from the grand total (unique/rung/missed/answered/TTT, rosterAgentCount, and the ans-per-day pair when both appearances counted it), and crossoverAgentCount counts it, so the existing caption explains the gap. Un-scoped rows from a changeover range (L7) are not treated as supersets (fail open), and two scoped slices still partition (P2 + P0 unchanged).

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 2401 tests, 2400 pass, 0 fail (1 skipped, pre-existing).
- `ci:ui` (CI=true) all green: no client change, but the combined view's computation changed.
- Lint clean; INV-16 in sync; module map regenerated.
- 7 bites, each failing its test as it should:
  - DATA-7: primary-only sections; sections:false; shared ctx.
  - DATA-6: summary key; insights key.
  - DATA-8: the subtraction; the fell-open gate.
- Regression scenarios S35 / S43 (combined view totals and CSV) are covered by drive-subqueue in ci:ui, PASS. S32 (queue data) is unaffected for the primary dept.
REGRESSION RISKS:
- DATA-6 adds a qcdAllFreshnessAnchor_ call to each summary/insights request. It goes through getLatestDataDates, which the 5-minute latestDates cache already serves; on the first deploy every summary/insights key changes once (a cold miss per key).
- DATA-7: a caller that read a CHILD part's qcd/csrTransfer would now see null; combineSummaries_ never ships them and no other caller passes the option.
- DATA-8 changes combined grand totals only when QUEUE_SPLIT_SCOPE=dept AND some dept fell open (B-1); with the default `off` nothing is scoped, so the path is inert.
INVARIANTS AT RISK: None.
- INV-30 (suffix added, documented).
- INV-36 (keys stay under 250 chars).
- INV-53 (floater totals untouched).
- S35's per-dept subtotal contract: subtotals stay un-deduped, and only the grand moves, with the caption.
NET SCORE: 0 − 0 = 0. None would have fired this month:
- DATA-6 needs a QCD-only change inside the 6 h window.
- DATA-7 is performance.
- DATA-8 needs QUEUE_SPLIT_SCOPE=dept, which is off.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Five other computeSummary_ callers use only the agent rows and totals, yet still compute the QCD snapshot and CSR transfer block on every call: AgentHome, Coaching, Digest, Diagnostics and SmokeCheck. Passing `{ sections: false }` there would save those reads; check each caller first (SmokeCheck may deliberately exercise the full path).
DOCUMENTATION UPDATES NEEDED:
- None beyond those made: CLAUDE.md (the Phase 2 de-dup exception), INV-30 (the QCD anchor), next-steps.md.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
