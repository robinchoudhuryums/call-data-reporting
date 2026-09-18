---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- D-5 | Swallowed QCD read errors were cached inside otherwise-good Overview / My Department payloads for 6 h
- OD-4 | The 13-month dqe_history prune was shorter than what the Neon read path requests (12-month trend + its INV-28 prior window)
- D-4 | The Neon DAL was not memoized per execution (one identical json_agg per dept on a combined view)
- D-7 | `summary:v22` and `individual_active:v2` keys carried no roster dimension (an Orphan-Fix add was invisible for the TTL)
- D-3 | `combineSummaries_` weighted per-dept NON-ZERO means by roster size
- D-8 | Insights `violationsMtd` was the CURRENT calendar month regardless of the window
- OD-3 | The egress meter missed the largest reads (backup, coverage, escalations, missed-enrich, audits, config-source)
- OD-5 | A pruned journey was shaped like a pre-capture row; the drill said capture predated the feature

Files modified:
- apps-script/department-dashboard/Config.gs (D-5 flag + helpers), QCDReport.gs (D-8), CompanyOverview.gs (D-5), Data.gs (D-5, D-7, D-3), Util.gs (D-7), NeonRetention.gs (OD-4, OD-3), NeonRead.gs (D-4, OD-4 note), InsightsReport.gs + CacheWarm.gs (insights:v24), script-8-insights.html (D-8 caption), script-5-dept.html (OD-5 note), NeonBackup.gs / NeonCoverage.gs / Escalations.gs / MissedCallsReport.gs / InboundReport.gs / OutboundReport.gs / DeptConfig.gs / Alerts.gs / Digest.gs / OrphanFix.gs (OD-3 metering), InboundReport.gs (OD-5 `journeyPrunedMeta_`)
- docs/invariants.md, docs/architecture.md, docs/client-ui-conventions.md, docs/sub-queue-split-plan.md, docs/known-issues.md, docs/conventions.md (insights:v24)
- tests: dal-cutover, subqueue-access, compute-summary (+ the R40 memo-family reset its install lacked), company-overview, qcd-report, journey-fallback, neon-retention; NEW tests/unit/neon-egress-coverage.test.js; tests/README.md

CHANGES:
D-5 | Config.gs, CompanyOverview.gs, Data.gs | `QCD_SNAPSHOT_READ_FAILED_` (per-execution, `var`) + `noteQcdSnapshotReadFailed_` / `qcdSnapshotReadFailed_`; the catches in `computeQcdSnapshots_` and `computeDeptQcdSnapshot_` note it; `getCompanyOverview`, `getOverviewChartTrend` and `getDepartmentSummary` skip their cache put when set (the `deptConfigReadFailed_` pattern); the summary meta carries `qcdReadFailed: true`. Lives in Config.gs so every selective-load suite sees it.
OD-4 | NeonRetention.gs, NeonRead.gs | `NEON_RETENTION_DEFAULTS_.historyMonths` and its FLOOR 13 -> 25 (a window ending today reaches ~24 months back through its INV-28 prior window; a window ending N months ago reaches 24+N, the documented limit); `neonGetAgentExtPairs_` documents that its DISTINCT set is horizon-bounded while the sheet scan sees all history. Test anchors moved to 25; an override ABOVE the floor (30) is honored, below (2) is floored.
D-4 | NeonRead.gs | `neonFetchDqeRows_` resolves `wantSplit` up front, builds `'neon|from|to|detail|split|agents'` and serves a shallow clone (LM2 marker carried) from `DQE_SHEET_ROWS_MEMO_` on a hit; only a `_neonReachable` result is memoized (FIFO cap unchanged). Same memo object as the sheet path, so no new R40 family member and every existing reset covers it. `logDqeReadTiming_('…:memo-hit', 'neon-memo', …)` on a hit.
D-7 | Data.gs, Util.gs | `summary:v22` key gains `hashAgents_(getRosterForDepartment_(dept).names)` (one extra roster read per request); `individual_active:v2` key gains `hashAgents_(roster.names)` (the roster is already a parameter). Key SUFFIX, no INV-30 bump (the CORE-3 pattern).
D-3 | Data.gs | `countNonzero_`; `totals.attNonzeroCount` / `avgAbdWaitNonzeroCount` / `csrAvgAbdWaitNonzeroCount` (also on the empty-totals shape); `combineSummaries_` weights each duration mean by that count, falling back to `rosterAgentCount` for a part without it. Comment corrected (the old text claimed the roster weighting matched `avgNonzero_`).
D-8 | QCDReport.gs, InsightsReport.gs, script-8-insights.html, docs | `computeQcdReport_` anchors MTD at `min(to, today)`; `computeMtdViolations_(…, anchorIso)` bounds BOTH ends of the month; `insights:v23` -> `v24` (docs synced: invariants, architecture, client-ui-conventions, sub-queue-split-plan, known-issues + conventions tables, CacheWarm.gs comment); the tile caption says "month-to-date through the window end". The Overview tile chip (current month) and the all-dept report (already range-end) are unchanged.
OD-3 | 11 files + new suite | `neonNoteEgress_` on: the backup's `nbFetchAgg_` (`backup`), `ncNeonDateCounts_` (`coverage`), the escalations badge / list counts / `escRowDepartment_` / `escRowMeta_` / `escRowFull_` / review ping (`escalations`), the Missed report's per-row enrich (`missed-enrich`), the inbound unattributed / no-entry-queue audits (`inbound-audit`), the journey reason probe (`callJourney`), the outbound vetting sample checks (`outbound-vetting`), `neonStorageByTable_` (`neon-storage`), the orphan-rename conflict count (`orphan-rename`), and the three config-source reads (`config`). `neon-egress-coverage.test.js` sweeps every `executeQuery(` in the dashboard for a `neonNoteEgress_(` within 26 lines, with a LISTED set of scalar probes (SELECT 1 / MIN / MAX) that the second test verifies are still scalar.
OD-5 | InboundReport.gs, script-5-dept.html | `journeyPrunedMeta_(call, dateIso, nowMs)` (pure): a found call with NULL `journey` older than `neonRetentionSettings_().journeyDays` (default 90) returns `{ journeyPruned, journeyHorizonDays, ageDays }`; both the inbound and outbound found-paths merge it; the drill appends "Leg-by-leg detail for this call was pruned — journeys are retained N days…" instead of implying capture predates the feature.

TEST RESULTS: passed -- `node --test` 1659/1659 under TZ=America/Chicago (11 new tests + 1 new suite). INV-16 guard clean. `npm run lint:gas` clean. `npm run ci:ui` RUN and passed (script-5 + script-8 changed). Bite-checks: D-4 memo, D-5 summary gate, D-5 overview gate, D-3 weighting, D-7 roster hash, D-8 upper bound, OD-3 backup metering, OD-5 pruned flag -- all BITE. NOTE: compute-summary's `install()` did not reset the R40 DQE memo family (the pin's documented "known hole"); it does now, and the D-3 test was its first victim.

REGRESSION RISKS:
- D-4: within ONE execution a later caller of the same window is served from the memo even if Neon went down in between (intended: same request). A test that flips the fake connection mid-execution must drop `DQE_SHEET_ROWS_MEMO_` (dal-cutover's CORE-2 test now does).
- D-7: one extra `DO NOT EDIT!` read per My Department request (the compute reads the same sheet); every existing summary key is invalidated on deploy (a one-time cold morning). `hashAgents_` is defined in Data.gs, so `computeActiveAgentsInRange_` (Util.gs) now requires Data.gs in scope -- every suite that loads it already does.
- D-3: combined duration means MOVE for existing combined views whenever a dept has zero-talk rostered agents (the number was wrong before; now it equals `avgNonzero_` over the contributing agents). Single-dept views unchanged. No cache bump: `summary:v22` keys carry the roster hash now, so every combined payload re-mints on deploy anyway.
- D-8: an Insights window in a PAST month now shows that month's violations (was the current month); windows ending today unchanged. `insights:v24` re-mints every Insights key.
- OD-4: `dqe_history` keeps ~12 more months (storage floor on the Health page rises; #57's cap may need +30%); the weekly prune deletes nothing until rows age past 25 months.
- D-5: a request whose QCD read throws recomputes on every request until the read heals (no put); the Overview's 5-min auto-refresh then pays the full compute -- the trade the finding asked for (a degraded blob must not pin).
- OD-3: the egress gauge (and `NEON_EGRESS_BUDGET_MB` threshold, #47) will read HIGHER, especially in a backup month -- that is the correction, not a regression; re-tune the budget after one month of honest figures.
- OD-5: the disclosure fires only when `neonRetentionSettings_` is in scope (the dashboard project); the default 90 days is used otherwise.

INVARIANTS AT RISK: None. INV-30 (insights bumped to v24 for the D-8 rule change; summary / individual_active gain key SUFFIXES, the documented CORE-3 pattern); INV-05 / INV-25 untouched (per-agent ATT unchanged; only the combined-total mean's weighting); INV-28 / INV-29 (OD-4 makes them hold on the Neon path); INV-53 (D-7 keeps the roster-change behavior R45 introduced for exts); INV-44 / INV-55 unchanged.

NET SCORE: 6 − 0 = 6
(a: fired this month -- D-5 YES (any transient QCD throw), OD-4 YES only with DQE_READ_SOURCE=neon AND retention armed (both are operator-set; counted NO), D-4 YES (every combined view on neon; NO if reads are on sheet -- counted YES for the IR parent-init case), D-7 YES (the last Orphan-Fix add), D-3 YES (every combined view with zero-talk agents), D-8 YES (any past-month Insights window), OD-3 YES (the September backup), OD-5 NO (no 91+-day drill observed); b: new failure mode -- NO for all 8.)

OPERATOR ACTIONS / DEPLOY:
- Review `NEON_STORAGE_CAP_MB` (#57) after deploy: dqe_history retention grew from 13 to 25 months, so the storage floor rises over the next weeks. | BLOCKS DEPLOY: N
- Expect the Neon egress gauge (#47) to read higher from the next backup on; re-tune `NEON_EGRESS_BUDGET_MB` after a month of honest figures. | BLOCKS DEPLOY: N
Deploy: Department Dashboard -- `scripts/deploy.sh . <dashboard-deployment-id>` (20 .gs files + script-5 / script-8 changed; ci:ui already green here).

FOLLOW-ON ITEMS:
- OD-4's other option (a disclosed "trend clipped at the retention horizon" note on the Neon read path for windows ending long ago) is not built; the 25-month floor covers windows ending within the last month.
- compute-summary's install() lacked the R40 memo-family reset until this batch; other suites that build a DQE fixture and reset nothing are still invisible to the pin (its documented hole).
- The Overview tile's "viol MTD" chip stays current-calendar-month (a tile, not a windowed report); Insights and the all-dept report now agree with each other.
- Batches 7-9 of the scan plan remain.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: the Neon read-back bullet's rule (4) (`neonGetAgentExtPairs_`) gains the OD-4 horizon note; the "A span bounds a dated read's WIDTH; only a per-execution MEMO bounds the COUNT" bullet should say the memo now covers the NEON path too (D-4); the CacheService-tiers decision gains the roster-hash rule for summary / individual_active (D-7); the sub-queue combined-view bullet's "duration means are agent-count-WEIGHTED" clause becomes "non-zero-count-weighted" (D-3); the System Health capacity-rows sentence can note OD-3 (the backup is metered).
- docs/operator-state.md: #57 (retention months 25; storage implication), #47 (the gauge now counts the backup), #22/#35 optional.
- docs/invariants.md INV-30: the D-8 v24 line (done) -- and the D-8 MTD rule belongs in docs/conventions.md's MTD definition.
- docs/fix-history.md: Batch 6 rows in the 2026-09-17 section.
- docs/known-issues.md "Overview tile chips / MTD": note Insights follows the window end (R12-24 parity).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
