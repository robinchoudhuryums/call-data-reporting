---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- DATA-5: computeSummary_'s sheet path ran a private span read (Data.gs ~1140), bypassing the R40 memo. It is charged once per dept in combined views and digests.
- DATA-6: the Overview's orphan nag read DQE cols A..D for all history, and re-read every roster, on every Overview cache miss (OrphanFix.gs ~471).
- S2A-2: the Company answer-rate line on the Overview's 60/90-day views covered only the last 30 days.
- DATA-8: computeTrendStartDate_ with a Feb-29 end date started the 12-month trend in March.

Files modified:
- apps-script/department-dashboard/: Util.gs, CompanyOverview.gs, Data.gs, OrphanFix.gs, DeptConfig.gs (cache-version comment only)
- tests/unit/:
  - behaviour: trend-window, company-overview, dqe-span-readers, orphan-rename-race
  - NeonRead.gs added to the load list: compute-summary, dept-summary-email, digest-freshness-gate, report-usage
- CLAUDE.md
- docs/: invariants.md, architecture.md, client-ui-conventions.md, conventions.md, known-issues.md, operator-state.md, fix-history.md, module-dependencies.md (regenerated)
- .cycle/: STATE.md, the plan

CHANGES:
DATA-8 | Util.gs | `setDate(1)` is now applied BEFORE `setMonth(-12)`, so a Feb-29 end starts the trend on Feb 1 of the prior year. It was the only copy of the pattern (the legacy dqe-report is frozen).
S2A-2 | CompanyOverview.gs | The company per-day loop now floors at min(30-day trend start, 90-day chart start), so `companyAggregate.trendChart` is populated across the whole chart axis. `companyRecentlyActive` stays gated on the 30-day start. INV-30: `companyOverview:v24` → `v25`, with every current-version doc mention and both markdown tables synced.
DATA-5 | Data.gs | The sheet fallback reads `sheetFetchDqeRows_(priorFrom, to)`: the identical normalized shape, memoized, with a shallow copy per caller, so the in-place narrowing stays per-dept. The all-history ext slice (`deptQueueExtsFromSheet_`) keeps its own read. The R44 read-count pin goes from wide = 2 to 1 for two depts. A new pin covers "Beta's totals are identical with or without Alpha warming the memo" plus the source shape.
DATA-6 | OrphanFix.gs, CompanyOverview.gs | `computeOrphans_(opts)`: `opts.rosterNames` skips `collectAllRosterNames_`. The sheet path reads cols A..D over `dqeWindowRowSpan_(cutoff, '9999-12-31')` (the shared date-column memo) instead of the whole sheet, keeping the per-row cutoff. `computeOverviewOrphanNag_` passes `Object.keys(deptsForAgent)`.
Test doubles | 4 suites + orphan-rename-race | Suites that reach computeSummary_ now load NeonRead.gs (it calls the DAL primitive). The orphan suite's `install()` resets all four per-execution DQE memos (the R40 test-side trap).
Every new test was bite-checked against HEAD and fails there.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 1894/1894.
- INV-16 in sync; module-deps up to date; `CI=1 npm run lint:gas` clean.
- `CI=1 npm run ci:ui`: all stages passed.
- All 30 failures seen on the first run were from this session: the suites without NeonRead.gs and the R44 double that encoded the old behaviour. All are fixed.

REGRESSION RISKS:
- DATA-5: computeSummary_ now depends on NeonRead.gs being in the project, which it always is in production. Behaviour is identical: same rows, same filter, per-caller copies.
- S2A-2: the `companyOverview:v25` bump means one cold Overview compute per key after deploy.
- DATA-6: the orphan scan's window now comes from the date-column memo. A caller that changed the sheet mid-execution would read a stale span; the memo's row-count guard catches growth.

INVARIANTS AT RISK: None.
- INV-29 is corrected for leap days.
- INV-30: the bump is made and synced.
- INV-39: the Company series stays inside companyAggregate (stripped for non-admins).
- The R40/R44 memo contract is preserved (shallow copy per caller).

NET SCORE: 3 − 0 = 3
- Production this month:
  - S2A-2 YES: an admin's 60/90-day chart.
  - DATA-5 YES: every combined view or digest on the sheet path.
  - DATA-6 YES: every Overview cache miss.
- DATA-8 NO: next Feb 29 is 2028.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or `scripts/deploy.sh .`), then Manage deployments → New version.

FOLLOW-ON ITEMS:
- The remaining DAL-bypassing span readers (IR, Insights, computeActiveAgentsInRange_, Alerts) still run private span reads outside the R40 memo. Each is charged once per request, not per dept, so the payoff is small. Unscheduled.
- `computeOrphans_` on the admin Orphan Fix init path still reads rosters itself; only the Overview path passes them in.
- Still open: CRT-4 on the dup-guard re-mirror (block 202), S2C-1 `agentBusy`, the `first_agent` audit, the callback table, Batches 10–11.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit, which updates:
  - the CLAUDE.md R41 bullet
  - INV-30 v25 plus the version tables
  - fix-history
---END BROAD SCAN IMPLEMENTATION SUMMARY---
