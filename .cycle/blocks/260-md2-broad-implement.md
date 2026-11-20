---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (MD2 is an owner-plan batch, new capability by owner ruling 2026-11-20, not a scan finding)
New capabilities (G/ST): MD2 -- the Overview trend chart gains a fifth view, "Avg answer time": how long an answered queue call waited before pickup, per department per day, weighted by answered calls. Admin-only Company line. No target line.
Files modified:
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/department-dashboard/script-3-overview.html
- apps-script/department-dashboard/script-4-nav.html (one chart tip)
- apps-script/department-dashboard/dashboard.html (the tab, a glossary line)
- apps-script/department-dashboard/OrphanFix.gs (a comment naming the cache version)
- tests/unit/overview-chart-answered.test.js, tests/unit/overview-qcd-snapshot.test.js, tests/unit/ch4-split-snapshot.test.js, tests/unit/snapshots/ch4-payloads.json
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/invariants.md (INV-30, INV-39), docs/regression-scenarios.md (S25), docs/architecture.md, docs/conventions.md, docs/known-issues.md, docs/per-call-capture.md, docs/fix-history.md (MD2 row), docs/module-dependencies.md (regenerated), tests/README.md, CLAUDE.md (the blob-size estimate)
- .cycle/STATE.md, .cycle/blocks/260-md2-broad-implement.md

CHANGES:
MD2 pre-check | QCDReport.gs (read only) | Confirmed before building: the avg-answer cell reaches the Overview on BOTH queue read sources (the sheet's display grid and the Neon grid's `displays`), and `readQcdGrid_` already removes exception days and keeps the display grid aligned with the value grid.
MD2 server | CompanyOverview.gs `computeQcdSnapshots_` | Each day gains the pair `aaSum` (sum of avg-answer seconds x answered) and `aaN` (answered), for the dept map and the once-per-queue-row company map. A row counts only when it has both an average and answered calls (the queue report's RPT-8 rule). Read from the display grid (INV-02); a grid with no display cells yields no figure rather than a throw.
MD2 server | CompanyOverview.gs `ovAvgAnswerSec_`, `ovDeptChartSeries_` | New series `trendAvgAnswerSec`: whole seconds, null on a day with no answered queue calls. Shipped per dept in both payloads (`trendChartAvgAnswerSec` in the 90-day blob, `trendAvgAnswerSec` in the YTD payload) and as a company series in `companyAggregate` / `company`.
MD2 admin-only | CompanyOverview.gs | The company series is on NEITHER non-admin allowlist (`personalizeOverview_`'s `companyTrendLine`, `ovStripChartTrend_`), so a manager's payload never carries it.
MD2 cache | CompanyOverview.gs + docs | `companyOverview:v31` -> `v32`, `overviewChartYtd:v4` -> `v5`, mirrored in every doc mention.
MD2 client | script-3-overview.html | `OV_CHART_METRICS_.avgAnswer` with a new `secs` unit: m:ss axis and hover text (`ovFmtSecs_`), axis ends and ticks snapped to one clock-friendly step (`ovSecsStep_`), no baseline, heading "Average time to answer per department (queue)". The range slice carries the series for depts and company.
MD2 client | dashboard.html, script-4-nav.html | The "Avg answer time" tab (hover text says it is not talk time), a glossary line, one chart tip.
MD2 tests | unit + rendered | Weighted average and the gap rule on both grid shapes; both payloads and both strips; the two m:ss helpers; the CH-4 golden regenerated (verified additive only: identical to the old golden once the new key is removed; manager and view-as payloads carry no company series). drive-smoke asserts the view for both roles (admin has the Company line, manager has none).

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,171 pass / 0 fail (1 skipped, pre-existing); `npm run lint:gas` clean; module map regenerated and up to date; `npm run ci:ui` all 18 runs passed; drive-smoke re-run after the last edit: admin 115/115, manager 86/86. Five pins bite-checked (unweighted average; a gap drawn as zero; a leak through each strip -- caught by four tests incl. the golden; m:ss zero pad). Regression Scenarios not walked live (needs a deploy): S25 gained the MD2 step.
REGRESSION RISKS: (1) Payload size. The 90-day Overview blob grows by an estimated ~4 KB (to ~46 KB of its ~100 KB cap). The YTD payload grows by ~13 KB: ESTIMATED ~73 KB now and ~81 KB at year end for 14 visible departments, against its 92,000-byte cache guard. Under the guard, but two more departments or a sixth series would cross it, after which the YTD chart is served uncached (it says so in the log). These are estimates from a synthetic payload, not production measurements. (2) The first request after deploy recomputes both payloads (new cache versions). (3) `computeQcdSnapshots_` now calls `parseHmsDisplay_` (Data.gs) once per mapped Total Calls row -- negligible.
INVARIANTS AT RISK: None violated. INV-39 (admin-only Overview fields): the new company series is admin-only by allowlist absence, pinned in both payloads. INV-30: both prefixes bumped and registered docs updated. INV-02: the duration is read from display values. INV-50: only `Total Calls` rows are summed, unchanged.
NET SCORE: 0 − 0 = 0 (new capability; the size risk above is a thinner margin on an existing guard, not a new failure path)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard, then walk S25's MD2 step as an admin and as a manager (or with View as) | BLOCKS DEPLOY: N
- After deploy, open the Overview once on YTD and read the execution log. Two warnings would matter, and neither is expected: "CompanyOverview: cached blob is N bytes ... approaching the CacheService limit" (the 90-day blob past 80 KB) and "overviewChartTrend: payload is N bytes, over the 92000-byte cache guard" (the YTD payload no longer cached) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The plan said "lower-is-better arrows like Abandoned %". The Overview chart has no trend arrows on any view, so there was nothing to add.
- The plan said a parent "includes its sub-queues' queues as the abandoned views do". The abandoned views use each dept's DIRECT queues only (children draw their own dashed lines), so this view does the same.
- YTD payload headroom: if a sixth chart series or more departments are added, split the YTD payload (or drop a series from it) first.
- A manager sees no Company line on this view by owner ruling; there is no on-screen note saying why. Add one only if managers ask.
- The dept tiles show no avg-answer figure; this is a chart view only.
- Next in the owner's plan: MD3 (one trend chart, Team total / By agent), then MD4.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
