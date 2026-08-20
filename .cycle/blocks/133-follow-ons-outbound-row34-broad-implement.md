---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (the open follow-ons from blocks 131 + 132):
- FO-1 | Row-34 code fix (unblocked by the 2026-08-20 owner ruling): the sidebar refuses row 34 as
  a total row + its extraction predicate removed; the pipeline's dead r34_abnd1m/2m counters
  deleted; the parity suite pins the refusal.
- FO-2 | Outbound report v2 — the deferred v1 extras: pendingTail counted bucket, per-day callback
  series + safeChart_ line chart, INV-28 kpisPrior/callbackPrior delta chips (R11-M), and the
  not-called-back drill list with "↳ path" journey chips. PLUS a correctness fix found while
  building: v1's abandon denominator missed the `is_internal` exclusion every inbound metric
  query carries — added and pinned (the "exactly the Inbound report's Abandoned population"
  claim is now actually true).

Files modified:
- apps-script/cdr-report/dataFilters.js            (row 34 → totalRows refusal; predicate removed;
                                                    34 out of isGlobalExcRow)
- apps-script/cdr-import/autoImport.js             (dead r34 counters deleted; pointer comment)
- apps-script/department-dashboard/OutboundReport.gs (v2: is_internal fix, pendingTail, daily
                                                    series, prior blocks, getOutboundUncalled;
                                                    prefix outboundReport:v1 → v2)
- apps-script/department-dashboard/dashboard.html  (chart canvas + uncalled button/list in the
                                                    callback section)
- apps-script/department-dashboard/script-9-inbound-direct.html (delta chips, pendingTail on the
                                                    Called-back tile, outboundRenderCbChart_,
                                                    outboundLoadUncalled_ reusing
                                                    heatCellDetailHtml_ + initClipboardOnce)
- tools/ui-harness/build-harness.js                (v2 payload fields; getOutboundUncalled mock)
- tests/unit/outbound-report.test.js               (+6 tests, 16 total; window-clause pin upgraded
                                                    to the count-based every-FROM pattern)
- tests/unit/qcd-sidebar-parity.test.js            (+1 refusal test; scope note updated)
- docs/known-issues.md                             (row-34 entry: code fix APPLIED)

CHANGES:

FO-1 | dataFilters.js + autoImport.js + qcd-sidebar-parity.test.js | Row 34 joins the sidebar's
`totalRows` refusal list (with a ruling comment) and its extraction rule is gone; 34 leaves the
now-unreachable isGlobalExcRow list. The pipeline's r34_abnd1m/r34_abnd2m declaration + increment
block are deleted (they were written NOWHERE — totalRowMap's 34:[35,36,37] sum, which IS the ruled
meaning, is untouched). The parity suite pins sidebarCellJSON_(34,5) → the total-row refusal
message, so a re-introduced row-34 predicate fails CI. Sheet output is byte-identical — this
change is sidebar-behavior + dead-code only. The 35+37 double-count inside the ruled sum remains
a documented property of the definition (known-issues), not silently "fixed".

FO-2 | OutboundReport.gs (v2) |
- `outboundAbandonWhere_` factors the denominator: disposition + range + work-window +
  **COALESCE(is_internal, FALSE) = FALSE** (the v1 gap) + the shared dept predicate. Used by the
  report, the daily series, the prior window, and the drill — one definition everywhere.
- `callback.pendingTail`: tracked, un-called-back abandons with call_date > current_date − 3 —
  "not called back YET", rendered as a count on the Called-back tile instead of a caption guess.
- `daily`: the same abandon⋈callback join grouped by call_date → {date, tracked, calledBack,
  ratePct(null when 0 tracked)}; client renders a THEME-colored safeChart_ line (datalabels off,
  hidden under 2 days, instance destroyed per render).
- `kpisPrior`/`callbackPrior`: computePriorWindow_ (typeof-guarded — Data.gs) drives two extra
  sub-selects; prior agents route through the SAME roster filter so the delta chips compare like
  with like; callbackPrior uses the same tracked-denominator rule. inboundDelta_ chips land on
  OB calls, Connect %, and Callback rate.
- `getOutboundUncalled` (new RPC, same resolver/vetting gate): tracked + not-called-back per-call
  rows (same lateral, so the list can never disagree with the KPI), newest-first, cap 200 + 1
  truncation probe, is_internal + window + dept predicates, NO caller identity in the response.
  Row shape matches getInboundHeatmapCell's calls, so the client reuses heatCellDetailHtml_
  verbatim — stage ticks, facts, and the "↳ path" journey chips (initClipboardOnce arms the
  delegated handler); an empty list renders "everyone was called back" (good news), not the
  generic no-abandons message. Cache prefix bumped v1→v2 (aggregation change, INV-30);
  cache-version-sync's regex picks the new literal up automatically.

TEST RESULTS: PASSED — 836/836 (was 829; +7: the row-34 refusal pin + 6 outbound-v2 tests incl.
the upgraded count-based every-FROM window pin, the is_internal pin, pendingTail/daily/prior
shaping, and the getOutboundUncalled predicates/truncation/gate/no-identity sweep). INV-16 guard
green; dataFilters.js + autoImport.js + OutboundReport.gs pass node --check. `npm run ci:ui` full
rendered gate: PASSED — all asserting stages green, exit 0.

REGRESSION RISKS:
- Row 34: an operator who previously drilled row 34 got a non-reconciling row list; they now get
  the total-row refusal — strictly more honest, and the ruling says so. QCDR Output numbers are
  byte-identical (the deleted counters were never written).
- outboundReport v1→v2 payload: additive fields + the is_internal narrowing. The only consumer is
  the same-commit client. The is_internal exclusion can only LOWER abandon counts (correctly —
  internal-origin test calls are not customer abandons).
- The daily series adds one more scan of the abandon join per compute — bounded by the abandon
  count, cached 6 h per scope.
- getOutboundUncalled is uncached by design (per-list, cheap, unavailable-must-not-pin — the
  heatmap-cell precedent).

INVARIANTS AT RISK: None. INV-30 honored (v2 bump WITH the aggregation change); the sidebar/
pipeline two-file discipline honored (both sides of row 34 changed together + parity-pinned);
the work-window owner ruling now count-pinned across every inbound_calls sub-select in the new
file; INV-01 (both endpoints read-only); no INV-16 duplicated file touched.

NET SCORE: +1 − 0 = +1
  (The is_internal fix is a real correctness fix on a shipped-this-week surface — internal-origin
  test calls would have inflated every callback denominator. Row-34 is drill-tool honesty; the
  rest is dark-surface capability.)

OPERATOR ACTIONS / DEPLOY:
- None blocking. The cdr-report + cdr-import diffs are behavior-neutral for the pipeline's sheet
  output (sidebar refusal + dead code); they ride the next deploy of each project. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (outbound v2).
CDR DQE Pipeline / Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (sidebar row-34).
CDR Import: `cd apps-script/cdr-import && clasp push -f` (dead-code removal, ride-along).

FOLLOW-ON ITEMS:
- Per-dept company-view cards for the Outbound report (the R11-C5 pattern) — STILL deferred, now
  with the design blocker stated: a crossover agent has MULTIPLE roster homes, so per-dept card
  grouping must either double-count them (one card per home) or pick a primary home
  (misattributes); the Direct report never faces this because direct_call_history rows are keyed
  per (agent, dept). Needs an owner ruling on which behavior managers should see; the flat table
  with the multi-home dept label dodges it honestly.
- The 35+37 double-count inside row 34's ruled sum — surface to the owner if the total ever
  drives a decision (documented in known-issues).
- dashboardCDR.js's 480-line generateCustomReportCore_ remains uncovered (needs the C1 fixture
  treatment) — carried from block 130.

DOCUMENTATION UPDATES NEEDED (next /sync-docs, folding into the queued items):
- CLAUDE.md Extraction Sidebar bullet: the row-34 "three-way incoherence awaiting an owner
  ruling" honest-exclusion clause is now RESOLVED — update to "row 34 refuses as a total row
  (ruled)". The outbound bullet's "sole consumer" clause (already queued from block 132).
- docs/invariants.md INV-30: outboundReport is v2 (supersedes the queued v1 note).
- tests/README.md: outbound-report.test.js + the parity suite's new pin.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
