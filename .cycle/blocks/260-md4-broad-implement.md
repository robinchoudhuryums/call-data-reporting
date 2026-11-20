---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: MD4 F-a -- an agent card's "open Individual Report" link (and its hover prefetch) did nothing for the admin while the brief held the Agents section: the handlers were delegated on `#insights-page`, and `#ins-brief` sits outside that element. Verified in the rendered page before fixing; now delegated on the document.
New capabilities (G/ST): MD4 (owner plan 2026-11-20) -- Queue health gets its own trend chart, linked to its table; the five "Queue:" entries leave the Trend dropdown. MD4 F-b -- the trend chart's By agent scope gets a Daily view (server per-agent day series, capped). MD4 F-c -- the dead Agents-section basis sub-toggle and the Absolute renderer are removed (cleanup).
Files modified:
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/styles.html
- apps-script/department-dashboard/script-4-nav.html (chart tips)
- apps-script/department-dashboard/script-1-core.html (theme-change repaint hook)
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/CacheWarm.gs (a comment naming the cache version)
- tests/unit/brief-accordion.test.js, tests/unit/insights-report.test.js, tests/unit/insights-partial-month.test.js, tests/unit/client-dead-ends.test.js
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/regression-scenarios.md (S14, S32, S61), docs/invariants.md (INV-30), docs/architecture.md, docs/conventions.md, docs/known-issues.md, docs/operator-state.md (a version mention), docs/insights-merge-plan.md, docs/fix-history.md (MD4 row), docs/module-dependencies.md (regenerated), tests/README.md, CLAUDE.md (one clause: the Absolute basis is deleted)
- .cycle/STATE.md, .cycle/blocks/260-md4-broad-implement.md

CHANGES:
MD4 chart | script-8-insights.html, dashboard.html, styles.html | New `insRenderQhChart_` on `#ins-qh-chart`, beside the per-queue table: one line per queue (+ a dashed dept total when there are several), for Abandoned % / Total calls / Violations / Avg answer time / Longest wait. Drawn fold-gated and measure-guarded (`insDrawQhChart_`). The legend spotlight, violation-day markers, point drill and partial-month marking carried over unchanged.
MD4 link to the table | script-8-insights.html, dashboard.html | Hovering OR focusing a queue's row highlights that queue's line (`insQhHighlight_`; a pinned queue wins). Three column headings (Total Calls, Abandoned %, Violations) are real buttons that pick the charted metric, with `aria-pressed` and an underline on the one charted. The Abandoned count has no series, so it stays a label.
MD4 views | script-8-insights.html | Monthly / Daily / Calendar (PURE `insQhResolveView_`): the Calendar is Abandoned % only; an unavailable view is disabled with a reason. The queue calendar is the SAME renderer as the team one, now parameterized (`insRenderTrendCalendar_(data, { queue: true })`, own host and month position; the eligibility helpers take the scope as an argument).
MD4 dropdown | dashboard.html, script-8-insights.html | The Trend dropdown lost its five "Queue:" entries (ten options to five); the Trends renderer has no queue branch left.
MD4 self-heal | script-8-insights.html | A prefs blob saved on a "Queue:" Trend entry (PURE `insQhHealFromPrefs_`): the Trend metric falls back to Answered, the healed prefs are saved, and Queue health opens once on that metric and view.
F-a | script-8-insights.html | The card link click and the hover prefetch are delegated on the document, limited to Insights' own markup (`insInSection_`).
F-b server | InsightsReport.gs | Each card carries `trendDays`: `[rung, answered, missed, pct]` per day of the selected window, aligned to `trendDaily.labels`, null on a day with no row (PURE `insAgentDaySeries_`). Shipped only for 2 to 45 days of data (`INSIGHTS_AGENT_DAILY_MAX_DAYS_`, also in `meta.agentDailyMaxDays`). `insights:v29` -> `v30`, mirrored in every doc mention.
F-b client | script-8-insights.html | By agent draws Daily from those tuples (PURE `insTrendAgentPoint_`); the reference line follows. The Monthly / Daily switch is the same one Team total uses (`insTrendViewSync_`); past the cap Daily is disabled with a reason. The Calendar stays Team total only.
F-c | script-8-insights.html, dashboard.html, CLAUDE.md | Removed: `#ins-cards-chart-mode`, `insCardsChartMode`, `insSyncCardsChartMode_`, `insRenderCardsChartAbs_`, the A/B remote's Basis row, the `cardsChartMode` prefs write. An old blob's field is still READ once, for MD3's Trend carry-over.
Tests | unit + rendered | Six MD4 tests + the changed MD3 pin in brief-accordion; two server tests in insights-report; two pins follow the moved renderer. drive-smoke: three checks on the queue chart (both roles), the relocated queue-calendar and P6 time-metric checks, and a fresh-page pass (prefs self-heal, By agent Daily on a 30-day window, the card link inside a brief row).

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,185 pass / 0 fail (1 skipped, pre-existing); `npm run lint:gas` clean; module map regenerated and up to date; `npm run ci:ui` all 18 runs passed on the final code. (An earlier full run failed both smoke shards on one NEW check of mine -- it seeded the old prefs blob after page load and raced a late prefs save under the gate's parallel load; the check now seeds before any page script runs. The product code did not change between those two runs.) Seven pins bite-checked. Regression Scenarios not walked live (needs a deploy).
REGRESSION RISKS: (1) Anyone used to the Trend dropdown's "Queue:" entries finds them in Queue health; a saved choice self-heals once. (2) Insights payload grows by the per-agent day series on windows of up to 45 days of data -- ESTIMATED 8 KB for 25 agents over 30 days, 17 KB at the cap -- against CacheService's ~100 KB per value; the current payload size is NOT measured, and a failed put is only logged ("InsightsReport cache put failed"), after which that window recomputes on every request. (3) The first Insights request per window after deploy recomputes (new cache version). (4) The Queue health table shares its row with the chart, so it is narrower (520 px basis); it wraps under on a narrow screen. (5) The data-labels choice for the queue chart is its own checkbox now, off by default.
INVARIANTS AT RISK: None violated. INV-30: `insights` bumped to v30 with the docs. INV-41: both charts go through `safeChart_`; the many-line By agent view keeps labels off. INV-53: the day series is built behind the same selected-roster gate as the monthly one (a floater gets none; pinned). INV-26: the daily reference line leaves excluded managers out. DD-2: the daily rate uses `answerRatePct_` on the server.
NET SCORE: 1 − 0 = 1 (F-a was a real dead control for the admin; reachable only through the A/B remote's Cards view, so "fired this month" is YES only if the admin used that view)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard, then walk S32's MD4 step (the queue chart, column headings, row highlight, Calendar), S14's and S61's MD4 steps | BLOCKS DEPLOY: N
- After deploy, open Insights for the largest department on "Last 30 days" and check the execution log for "InsightsReport cache put failed" (not expected) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Insights payload size is not logged anywhere (the Overview's is). A one-line size log on its cache put would turn risk (2) from an estimate into a number.
- The calendar's old per-calendar metric pref (`insCalMetric`, saved as `calMetric`) is vestigial since R11-C3; left alone.
- By agent has no Calendar (one grid cannot show many agents) and no Daily view past 45 days of data, by design.
- The Avg answer time and Longest wait metrics are reachable from the chart's Metric menu only; the table has no column for them (they are in each row's expand).
- The owner's MD plan is complete (MD1-MD4). Nothing further is queued.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
