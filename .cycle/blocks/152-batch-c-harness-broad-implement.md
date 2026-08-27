---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (2026-08-27 broad-scan — Batch C + the two increment-151 follow-ons)
- Follow-on 1 — processNewImport bulk-flow harness: queueToPendingArchive per-type counts pinned behaviorally, processIntegratedHistory's P26 forceDeleted gating pinned behaviorally (fires on actually-deleted only), and the bulk-branch guard wiring pinned by source (FO-1 style) — all in csr-transfer.test.js
- Follow-on 2 — coaching FLAG-GATED test now saves/RESTORES the real coachingDeliveryRun_ binding instead of `delete`ing it from the vm context; the increment-151 reinstall workaround removed
- L3 — Overview card `periods` (Yesterday/Last30/YTD) + the 30/60/90-day chart pass rebuilt PER DEPT through queueSplitNarrowedCopy_ (like the main pass + YTD endpoint) — under QUEUE_SPLIT_SCOPE=dept one card's tile, period row, and chart no longer disagree on the same day; flag-off output arithmetically identical
- L4 — computeDeptQcdSnapshot_'s Neon read window now also covers opts.priorFrom — the team-strip delta chips' prior block is no longer truncated on selections reaching near/past the 180-day lookback
- L5 — Insights team accumulators (teamCurr/teamPrev/dailyTeam/monthlyTeam/ytdTeam/teamAvgBase/deptAnsweredCurr/deptAnsweredExcluded/activeRoster divisors) are WHOLE-ROSTER, selection-independent; per-agent card accumulators stay selection-gated. Restores the claimed IR parity on partial "Comparison & agents" picks and fixes the excludedAnsweredShare under-report. `insights:v22 → v23`, synced across 7 doc/code locations (test-enforced)
- L6 — Missed report: when a time-key's AF↔AD pending ids OUTNUMBER its rendered rings (the narrowed-timeline shape; also a rare un-narrowed out-of-band-abandon corner that previously MISPAIRED), the key's pairing is dropped — a ring renders plain rather than drilling a possibly-wrong call. AD-derived dept counts stay fail-open all-queue (documented in the CLAUDE.md queue-split bullet)
- L7 — combineSummaries_ subtracts a crossover repeat only when both appearances carry IDENTICAL core figures (the Phase-0 premise); mixed changeover-straddling ranges no longer under-count, and skipping the subtraction leaves grand == sum-of-subtotals so no caption discrepancy arises

Files modified:
- apps-script/department-dashboard/Data.gs (L4, L7), CompanyOverview.gs (L3), InsightsReport.gs (L5 + v23), MissedCallsReport.gs (L6), CacheWarm.gs (v23 mention)
- CLAUDE.md (queue-split AD note, insights:v23) + docs/{invariants,architecture,known-issues,conventions,client-ui-conventions,sub-queue-split-plan,fix-history}.md (v23 sync + L3–L7 history)
- tests/unit/{csr-transfer,coaching,insights-report,queue-split,missed-report,overview-qcd-snapshot}.test.js

CHANGES:
Harness | csr-transfer.test.js | +3 tests: per-type queue counts (zero-CSR visible), processIntegratedHistory guard behavior under forceDeleted variants (fires/suppresses correctly), source pin of the four forceDeleted-gated call sites.
Coaching test | coaching.test.js | FLAG-GATED test restores the saved real binding; workaround helper deleted.
L3 | CompanyOverview.gs | isolated periods/chart pass restructured per-dept + narrowed; per-(row,dept) accumulation arithmetically identical to the old owners.forEach when the flag is off (pinned by the 51 pre-existing overview/summary tests + a routing source pin).
L4 | Data.gs | `_readFrom` = min(lookback, from, priorFrom); docstring updated; behavioral pin captures the readQcdGrid_ window.
L5 | InsightsReport.gs | selection gate moved off the team accumulators; deptAnsweredCurr folded into the roster branch; per-agent monthly stays selected-roster (pre-L5 gate preserved); parity pinned (partial vs full selection teamStats + meta.teamAvgBasis identical).
L6 | MissedCallsReport.gs | per-key count check after the FIFO build deletes over-subscribed keys; RPT-1's out-of-band AD counting untouched (pinned: ambiguous key un-marked, balanced key byte-identical, abandonedCallCount still counts all ids).
L7 | Data.gs | seenRoster stores first-appearance figures; unequal repeat → no subtraction, no crossover count (pinned both directions).

TEST RESULTS: 952/952 pass (was 944; +8: 3 harness, L3 routing pin, L4, L5, L6, L7). INV-16 guard, cache-version-sync, claude-md-split all green.
REGRESSION RISKS: L5 corrects team numbers managers see on partial selections (v23 prevents mixed-version serves; whole-roster is the documented intent). L3's per-dept filter loop runs 14× over the read window's rows, matching the main pass's existing cost pattern. L4 widens the Neon read window when priorFrom precedes the lookback — small extra egress for a correct prior. L6 removes the siren/drill from ambiguous rings — under-marking a transient corner beats wrong-drilling (and it fixes a latent un-narrowed mispair corner). L7's skip-subtraction over-counts only in the transient changeover state (fail-open by doctrine).
INVARIANTS AT RISK: None — INV-30 honored (v23, test-enforced sync); INV-53/25/27/28 untouched (floater gates, per-agent monthly, prior windows all preserved); queue-split fail-open rules B-1/S2-0 all still pass; INV-16 untouched.
NET SCORE: 5 − 0 = 5 (L5 plausibly firing today via partial selections; L3/L4/L6/L7 latent until the documented flag/cutover flips — which is exactly when they'd have been undebuggable).

OPERATOR ACTIONS / DEPLOY:
- None — no new properties, triggers, scopes, sheets, or migrations. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root + New version (or `scripts/deploy.sh .`)
- (cdr-import/cdr-report unchanged this increment — tests only)

FOLLOW-ON ITEMS:
- The Batch C flag-on end-to-end walk (Operator State #42's flip checklist) remains the operator's pre-flip verification; the unit pins cover the mechanics.
- Batches D (enforcement holes S1–S4/S7/S8), E (client polish + a11y), F (strategic) remain from the 2026-08-27 scan.

DOCUMENTATION UPDATES NEEDED:
- None — CLAUDE.md queue-split bullet, invariants v23 mentions, and fix-history entries all updated in this increment (test-enforced where applicable).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
