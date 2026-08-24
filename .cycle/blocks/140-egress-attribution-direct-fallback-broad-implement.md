---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- EA-1 | Per-surface Neon egress attribution: every neonNoteEgress_ callsite passes a surface
  label; the gauge stores per-label sub-counts and the Health row ranks the top consumers —
  egress reduction was flying blind with only the monthly total.
- DC-1 | Direct Call report SHEET FALLBACK: the report used to go dark on a Neon failure even
  though `Direct Call History` (the sheet) is the PRIMARY and Neon only the mirror. On any
  Neon failure it now re-derives the SAME payload from the sheet.

Files modified:
- apps-script/department-dashboard/NeonRead.gs          (EA-1: neonNoteEgress_ surface param +
                                                         by-map with 24-label cap; readNeonEgress_
                                                         `top` ranking)
- apps-script/department-dashboard/SystemHealth.gs      (EA-1: the neon-egress row appends
                                                         'top: <surface> N MB, ...')
- CallerLookup.gs, Coaching.gs, DirectCallReport.gs, Escalations.gs, InboundReport.gs,
  OutboundReport.gs, QCDReport.gs                       (EA-1: all 19 callsites labeled —
                                                         caller-lookup / coaching / direct /
                                                         escalations / inbound, inbound-insurer,
                                                         inbound-scan, inbound-parity, heatmap,
                                                         inbound-drill / dqe, dqe-exts / outbound,
                                                         outbound-drill, outbound-vetting / qcd)
- apps-script/department-dashboard/DirectCallReport.gs  (DC-1: shaping refactored into the shared
                                                         directCallShapePayload_; three failure
                                                         branches route to directCallSheetFallback_;
                                                         fallback payloads excluded from the cache)
- apps-script/department-dashboard/script-9-inbound-direct.html (DC-1: fallback disclosure note)
- tests/unit/system-health.test.js (+4), tests/unit/direct-fallback.test.js (NEW, 6)
- CLAUDE.md (Direct bullet + System Health capacity-rows sentence),
  docs/operator-state.md (#47 attribution guidance), docs/known-issues.md (DC-1 note)

CHANGES:

EA-1 | NeonRead.gs + SystemHealth.gs + 7 reader files | `neonNoteEgress_(bytes, surface)`
stores `{m, bytes, reads, by: {label: {b, r}}}`; distinct labels cap at
NEON_EGRESS_MAX_SURFACES_=24 (overflow and unlabeled calls fold into 'other') so the Script
Property stays under the 9 KB value cap; a pre-attribution stored counter upgrades in place
(earlier reads that month stay unattributed — totals never reset). `readNeonEgress_` returns
`top` (top 5 by bytes); the Health page's "Neon read volume" row appends the ranking, and a
pre-attribution payload renders exactly as before. Totals and the existing budget/threshold
semantics are untouched — the four pre-existing F5 tests pass unmodified.

DC-1 | DirectCallReport.gs + script-9 | The Neon path's payload shaping (lines that built
meta/kpis/kpisPrior/deptsPrior/agents) is extracted into `directCallShapePayload_(scope, obj)`,
consumed by BOTH sources, so shaping cannot diverge structurally. The new
`directCallSheetFallback_` (wired into conn-null / null-result / catch) reads
`Direct Call History` by position (18 cols per DIRECT_CALL_HISTORY_HEADERS), normalizes dates
via ncCellDateIso_ (display-read, the F-10 class), and mirrors the SQL's aggregation exactly:
per-(agent, dept) rows (B-1), DISTINCT agent_name kpi count (a crossover agent is one person),
ORDER BY ib_answered DESC then agent, busy carve-out excluded from the rate via the shared
rate helper, the INV-28/R24 prior window via the same computePriorWindow_, kpisPrior always an
object of sums (the SQL sub-select never returns null), per-dept prior aggregates, unscoped
coverageStart. One sheet read covers both windows. Disclosed via meta.fallbackSource='sheet';
NEVER cached (getDirectCallReport's put now requires !fallbackSource); missing/empty sheet
keeps the old available=false hide. Client: an idempotent `.ds-note` above the report body —
worded to say the figures are COMPLETE (the sheet is the primary), unlike the heatmap
fallback's "data through" ceiling.

Tests | +10 (870 → 880). system-health.test.js EA-1 (4): per-surface accumulation + ranking;
unlabeled/overflow folding with the 24-label cap and no lost bytes; in-place upgrade of a
pre-attribution counter; the Health row's ranking suffix present with `top` and absent without.
direct-fallback.test.js (6): the SOURCE-PARITY headline — one fixture (incl. a crossover agent
and a busy-heavy agent) aggregated independently in the test into the SQL's json shape, served
through the Neon path, then through the sheet fallback, payloads asserted deepEqual modulo the
disclosure field; fallback numbers (busy carve-out rate, distinct-agent count, ordering,
coverageStart); dept-scope predicate mirror incl. scoped deptsPrior; never-cached vs
healthy-cached; query-throw reaches the fallback; missing sheet keeps available=false.

TEST RESULTS: PASSED — 880/880 (was 870). INV-16 guard green. `npm run ci:ui` FULL GATE PASSED
(164 PASS lines, all stages; required — script-9-inbound-direct.html changed; existing fixtures
carry no fallbackSource so the note is inert in the gate). CLAUDE.md split/ratchet guards green
(both touched bullets under 4,096 B). node --check clean.

REGRESSION RISKS:
- EA-1 grows the NEON_EGRESS_MTD property (~40-60 B/label, ≤24 labels + totals ≈ well under
  the 9 KB cap); the write stays lock-free/lossy by design — unchanged class.
- DC-1's aggregation mirror can drift from the SQL (the known hand-mirror class): mitigated by
  the shared shaper (structural) + the independent-aggregation parity fixture (behavioral).
- The Direct fallback reads the whole Date column once per failed request (needed for the
  SQL-parity unscoped coverageStart) — bounded by sheet size (~150 rows/day), uncached,
  failure-path only, admin-only report. Acceptable; noted here so a future
  50K-row sheet doesn't surprise anyone.
- The shaping refactor is behavior-preserving by construction (moved lines, same math);
  direct-call-report.test.js passes unmodified, which pins that.

INVARIANTS AT RISK: None. INV-01 clean (fallback read-only). INV-30: no cache-rule change
(fallback uncached; the healthy key untouched; no version bump needed — payload shape only
GAINS the optional meta.fallbackSource on uncached serves). INV-28 prior-window semantics
inherited via the same computePriorWindow_ both paths call.

NET SCORE: 0 − 0 = +0
  (Both are resilience/observability for the ongoing outage class: nothing was mis-computing
  in production this month — the Direct report was dark during the outage, which DC-1 ends,
  and EA-1 makes the egress remedy pickable from evidence.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (only the dashboard changed). | BLOCKS DEPLOY: N
- Nothing to install/configure: attribution starts accumulating on the next Neon read (this
  month's earlier bytes stay unattributed until the Sep 1 reset); the Direct fallback is
  automatic. Read the Health row's "top:" ranking after ~a week of normal use, then pick the
  egress lever it names. | BLOCKS DEPLOY: N
- Live smoke: with Neon still down, open the Direct Calls report as admin — it should render
  from the sheet with the "figures are complete" note instead of "unavailable". | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- Egress levers proper (payload-shape slimming to json_build_array in Direct/Inbound/Outbound;
  SQL-side rollups for the 12-month trends) — deliberately NOT done here: pick from the EA-1
  ranking once it has a week of data, per the measure-first ordering.
- Inbound-report-lite sheet fallback (KPIs/daily/stage/insurer from the extended tab) — build
  only if outages persist after the Neon-ceiling remedy.
- The full dal-cutover pattern for Direct (read-source flag + live parity gate, reading the
  sheet as primary even when Neon is up) — the error-fallback shipped here is the smaller,
  safer step; escalate to cutover only if Neon egress cost or trust argues for it.
- Unchanged ledger: Outbound release runbook, 08/20 backfills before ~Sep 3, coaching arming,
  the increment-139 operator steps (export trigger install + one-time re-export).

DOCUMENTATION UPDATES NEEDED:
- Applied in this change: CLAUDE.md (Direct bullet DC-1 sentence; System Health bullet's
  ranking sentence), docs/operator-state.md #47 (read-the-ranking-first guidance),
  docs/known-issues.md (DC-1 paragraph in the fallback-limits entry). Nothing further.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
