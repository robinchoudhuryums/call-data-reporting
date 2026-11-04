---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (owner testing notes, 2026-11-04):
- AC-1 Agent Call Metrics header sticky on page scroll
- AC-2 Talk column carries ATT (total + average per call, both directions) in Both / Outbound / day quick view
- AC-3 combined ans/day counts a CSR + Spanish agent's working day once (summary:v25)
- AC-4 Outbound-only view lists only agents who placed a call
- AC-5 Transfer % amber 30-32 % inclusive, red above 32 % (one tier rule)
- DCA-2 former employees' reassigned extensions: a blank-name direct leg is credited only when the extension named its roster person that day
New capabilities (G/ST): AC-6 the agent panel's Direct tab + Neon direct_calls per-call capture; rebuildDirectCallHeldDates; diagnoseDirectCallAttributionAllDates
Files modified:
- apps-script/department-dashboard: Data.gs, AgentDay.gs, Config.gs, Util.gs, OrphanFix.gs (comment), NeonBackup.gs, NeonRetention.gs, script-4-nav.html, script-5-dept.html, script-7-admin.html, script-10-escalations.html, styles.html, dashboard.html
- apps-script/cdr-import: directCallMetrics.js
- tests: direct-calls-capture.test.js (new), queue-split, direct-call-metrics, direct-call-backfill, answer-targets, compute-summary, neon-retention; tests/README.md
- tools/ui-harness: build-harness.js, drive-deptoutbound.js, drive-agentpanel.js
- docs: operator-state (#37, #83, #90 new), fix-history, per-call-capture, client-ui-conventions, regression-scenarios (S56, S57, S58 typo), invariants/conventions/architecture/known-issues (summary:v25), CLAUDE.md (#90 index, summary:v25)

CHANGES:
AC-1 | styles.html | >= 1200 px: .agents-table-wrap overflow-x visible, header top = --dept-sticky-h, Both-view bar cells 140 px
AC-2 | script-5-dept.html | obTalkCellHtml_(in, out, inAtt, outAtt, outOnly); "Talk · avg"
AC-3 | Data.gs | totals._activeDaysByAgent (non-enumerable); combineSummaries_ subtracts (sum of days - union) for a crossover agent's narrowed rows; summary:v25
AC-4 | script-5-dept.html | outOnly groups filtered to obTotal > 0
AC-5 | script-5-dept.html / Config.gs / script-4-nav / script-7-admin / dashboard.html | xferTier_ (one ladder, amber inclusive), default 25/30/32, help + editor wording
DCA-2 | directCallMetrics.js | ownerSeen pre-pass + confirmBlank; blankUnconfirmed counters in the diagnostic; diagnoseDirectCallAttributionAllDates
AC-6 | directCallMetrics.js / AgentDay.gs / script-10 / script-5 / NeonBackup / NeonRetention | opts.events records; direct_calls table written in the counts' transaction (hash only for outside parties); rebuildDirectCallHeldDates; agentDayDirect_ (admin-only, inbound_calls fallback); Direct tab + quick-view section; backup/restore/retention lists

TEST RESULTS: node --test 2817 pass / 0 fail (TZ=America/Chicago); lint:gas clean; module-deps clean; INV-16 clean; bites 5/5 (AC-3 day union, DCA-2 confirm, AC-6 hash only, AC-6 admin gate, AC-5 inclusive amber); drive-deptoutbound 65/65, drive-agentpanel 38/38; full ci:ui: see STATE
REGRESSION RISKS:
- DCA-2: an active agent whose legs carry NO name all day (never observed, unmeasured) would lose that day's direct credit. diagnoseDirectCallAttributionAllDates' "unconfirmed" line names any such extension.
- AC-1 depends on every view fitting its column at >= 1200 px (measured 1280 / 1440); a much wider future column would overflow instead of scroll.
INVARIANTS AT RISK: INV-30 (summary:v25 recorded); INV-05 (the AC-2 inbound average is the INV-05 mean); INV-53 untouched -- none violated
NET SCORE: 3 production fixes (AC-3, DCA-2, AC-1) - 1 new failure mode (DCA-2's blank-day case, documented) = 2

OPERATOR ACTIONS / DEPLOY:
- Push cdr-import, then run rebuildDirectCallHeldDates() once (cdr-import editor) | BLOCKS DEPLOY: N
- Standards editor: if Transfer shows amber 35 saved, set it to 32 | BLOCKS DEPLOY: N
- Optional: diagnoseDirectCallAttributionAllDates() and send the "unconfirmed" lines | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root + new deployment version (or scripts/deploy.sh .); CDR Import: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- Dates before the held Call_Legs window keep the pre-DCA-2 (and pre-DCA-1) direct credit until their source is re-imported (#56).
- The bulk backfill path (skipNeon) writes no direct_calls list.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
