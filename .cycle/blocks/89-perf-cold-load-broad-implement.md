---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: PERF-1 (CacheWarm warmed a window the page no longer loads — every first dept open paid a cold aggregation); PERF-2 (two sequential Apps Script round trips before the Insights report could start)
Files modified: apps-script/department-dashboard/CacheWarm.gs, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/script-5-dept.html, docs/operator-state.md

CHANGES:
PERF-1 | CacheWarm.gs | The insights warm ran only over the LAUNCHER window (last 30 days ending yesterday). Since the M2 one-date-authority rule, the inline Insights section takes the DEPT page's window, which defaults to `latest..latest` (INV-43). The cache key carries the window (`insights:v19:<dept>:<from>:<to>:…`), so the warmed entry was never read — every manager's first dept open paid a full cold aggregation while the heaviest ~4 min of the warm job produced unread entries. Now TWO passes, most-used first (dept default, then launcher window — still needed for the Help quick-start chips) under ONE shared budget, so a tight budget degrades the rarer path. Extracted `warmInsightsWindow_(from, to, label)`; skipped counts summed across passes; header doc + log labels updated.
PERF-2 | script-8-insights.html | The first-open auto-run was consumed post-roster in `insRenderAgentList`, so `getInsightsReport` could not dispatch until `getInsightsReportInit` returned (itself a DQE scan via `computeActiveAgentsInRange_`). An agent-free run needs nothing from the roster (`irGetCheckedAgents_` → `[]`, `subqPickerScope_` → `{dept:null}`; server defaults to the whole roster, INV-45). The run now fires in parallel, deferred ONE TICK so synchronous post-entry writers land first and it stands down for paths owning their window/selection: quick-start chip (`insLauncherAutoRun_`), share/deep link (`insPendingAgentSelection_`), plus a no-dates guard. Re-checked at fire time, not captured. Also fixed the stale `insSetDefaultDates` comment that claimed the 30-day default matched the warm (it is the fallback-only path since M2).
PERF-2 | script-5-dept.html | `deptInsightsEnsureLive_()` moved from the top of `refresh()` to AFTER the `getDepartmentSummary` dispatch, so the agent table — what the manager reads first — keeps the head start and the Insights legs queue behind it.
PERF-1 | docs/operator-state.md | Item #21 rewritten: the two-window warm, why warming only the launcher window was a silent miss, and the note that a 1-day window is NOT cheaper to compute than a 30-day one (both fetch the whole 12-month trend range, INV-29) so ordering rather than window size is what the budget buys.

TEST RESULTS: passed — 651/651 `node --test`, INV-16 guard, `npm run ci:ui` 24+16+30+14. Live-DOM measurement in the harness (mock latency 60–180 ms/call): `getInsightsReport` previously dispatched a full round trip behind `getInsightsReportInit`; it now dispatches in the SAME millisecond (gap 0 ms) with exactly ONE run. Guards verified end-to-end: the quick-start chip still runs once over its own 29-day window (not the dept window); a deep link carrying `?from=…&agents=…` still runs once over the SHARED window with the shared agent selection applied (probe drove the real router path by intercepting the harness's `window.google` assignment, since it hardcodes an empty hash).

REGRESSION RISKS:
- CacheWarm now attempts up to 2× the insights aggregations (2 windows × N depts) inside the SAME 4-minute budget, so on a slow morning the launcher-window pass may be partially skipped where it previously completed. Deliberate priority inversion — the dept-default pass is the one every manager hits; skips are logged per pass and surfaced in the outcome line.
- The parallel run reads the picker before the roster renders. Safe for the agent-free case (both readers tolerate an unrendered list, verified), and the `insPendingAgentSelection_` guard defers to the roster whenever a selection exists.
- Report Usage telemetry is unchanged in shape; the warm still suppresses it via `REPORT_USAGE_SUPPRESS_`.

INVARIANTS AT RISK: None. INV-45 preserved (agent-free run defaults to the whole roster — that is exactly what makes the parallel fire valid); INV-43 is now honored by the warm rather than contradicted; INV-29 unchanged (referenced, not altered); no cache-key or payload changes, so INV-30 needs no bump.

NET SCORE: 2 − 0 = 2 (PERF-1 was firing in production daily — every first dept open of the day, for every dept; PERF-2 added a full round trip to every first open. No new failure modes: both guarded paths verified end-to-end.)

OPERATOR ACTIONS / DEPLOY:
- Confirm the cache-warm trigger is actually installed (Alerts modal → Report cache warming). PERF-1 only pays off if it runs; if it is off, the fix is inert. | BLOCKS DEPLOY: N
- Worth checking `DQE_READ_SOURCE` (Operator State #19) — if still on sheet reads, flipping to `neon` after a clean parity gate is the largest remaining server-side lever. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- The DEPT-SWITCH path still serializes init → report (measured +21 ms vs +190 ms in the harness). Deliberately out of scope: firing early there would read the OUTGOING dept's checked agents, so the picker must be cleared first — needs care, and the path is admin/multi-dept-manager only (single-dept managers have no selector).
- A dept switch dispatches `getInsightsReportInit` TWICE (once from `insEnsurePage_`, once from the dept-switch branch of `insSyncToDeptWindow_`); the second supersedes the first via `insRosterReqSeq_`, so it is wasted work rather than a correctness bug. Introduced in N1.
- Cold boot dispatches `getDepartmentSummary` TWICE (~3 ms apart) — `refresh()` runs once during init and again after `getLatestDataDates` lands. Pre-existing, unrelated to this work, but it is a free round trip on every page load.
- Warming `getInsightsReportInit` / `individual_active:v2` was considered and skipped: after PERF-2 the init is off the report's critical path, and the budget is already contested.
- If cold generates still drag after this, the remaining lever is splitting the endpoint for progressive render (KPIs + rollup first, trend + queue health second) — a payload-shape change, not a tweak.

DOCUMENTATION UPDATES NEEDED:
- None beyond those shipped (Operator State #21 + the corrected in-code comment).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
