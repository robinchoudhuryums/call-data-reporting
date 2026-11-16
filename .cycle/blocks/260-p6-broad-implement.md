---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: From the follow-up plan of 2026-11-13 (owner notes, not scan findings): P6 (answer-time trends), plus the owner's addition of 2026-11-16 -- Queue Call Data gets the loading frost the other side panels have (QCD-F).
New capabilities (G/ST): None from the scan's expansion plan. P6 itself is new capability: a Longest wait card with day bars on My Department, and Queue: Avg answer time / Queue: Longest wait on the Insights trend chart.
Files modified: apps-script/department-dashboard/Data.gs, QCDReport.gs, InsightsReport.gs, CacheWarm.gs + OrphanFix.gs (version mentions), script-5-dept.html, script-8-insights.html, dashboard.html, styles.html; tests/unit/day-bars.test.js, insights-report.test.js, insights-partial-month.test.js, compute-summary.test.js; tools/ui-harness/drive-daybars.js, drive-smoke.js, drive-deptoutbound.js, README.md; CLAUDE.md; docs/client-ui-conventions.md, fix-history.md, regression-scenarios.md, invariants.md, conventions.md, known-issues.md, architecture.md, operator-state.md, module-dependencies.md; .cycle/STATE.md.

CHANGES:
P6 | Data.gs | `computeDeptQcdSnapshot_`'s range blocks (`qcd.range`, `qcd.rangePrior`) carry `longestWaitSec` / `longestWait`: the longest any caller waited in the dept's OWN queues over the block (QCD Historical Data col I, a MAX across queues and days; sub-queues excluded; null on the blocks that do not read it). The per-day tuples (`range.daily`, `range.dailyExcluded`) gain a 6th element, that day's longest wait (null = none). `summary:v27`.
P6 | QCDReport.gs | `computeQcdReport_` accumulates avg answer (answered-weighted, RPT-8) and longest wait (a max) per queue per day, per queue per month, and for the dept's own queues. Monthly rows gain `avgAnswerSec` / `longestWaitSec`; the daily values leave as compact arrays (`dailyAnswerTimes`, aligned to `dailySeries`' dates, null = none) instead of fields on the per-day rows, which ship per queue per day in the Insights payload.
P6 | InsightsReport.gs | `queueHealth.trend.metrics` gains `avgAnswer` and `longestWait` (seconds; `total`, `perQueue`, `dailyTotal`, `dailyPerQueue`), null where a day or month has none. `insights:v27`.
P6 | script-5-dept.html, styles.html | A Longest wait card (`data-dts-metric="qmax"`) beside Avg answer, with a vs-prior chip (a rise warns; muted under 15 s) and day bars (a week / month bar is its longest day). The strip's grid follows its card count: four keep the four-up row, five get one row from 1360px, six sit as two rows of three.
P6 | script-8-insights.html, dashboard.html | The trend chart's Metric list gains Queue: Avg answer time and Queue: Longest wait -- one line per queue plus the dashed dept total, monthly and daily, on a minutes:seconds axis with clock-friendly steps; no data is a gap; line-only (no calendar); never marked as a partial-month count.
QCD-F | script-5-dept.html | `dept-qcd-snapshot` joined `SIDE_BUSY_PANELS_`, so Queue Call Data frosts with the page on a same-department refresh and clears on the live repaint or a failure.

TEST RESULTS: passed — `TZ=America/Chicago node --test` 3088 pass, 0 fail, 1 skipped (6 new tests in day-bars.test.js and insights-report.test.js; two existing pins updated: the per-day tuple shape and the partial-month condition); `npm run lint:gas` clean; module-deps regenerated; cache-version sync green after the two bumps; `npm run ci:ui` all stages passed, with 5 new rendered checks (drive-daybars.js 2, drive-smoke.js 2, drive-deptoutbound.js 1); 9 bite-checks, each named test went red on its mutation (one did not bite at first -- the cross-queue weighting had no two-own-queue fixture -- and a test was added so it does). Regression scenarios were not walked against the live app; the new steps in S62 and S37 are the owner's to walk.
REGRESSION RISKS: (1) The Longest wait card and the two new trend metrics are visible to managers as well as admins (like Avg answer; only the day bars stay admin-only). (2) The figure is the longest WAIT of any call, answered or abandoned -- the pipeline's col I is a max over every call -- so it is not a "longest answer time"; the card and tooltip say so. (3) The Insights payload grows by two number arrays per queue per day; a window already near CacheService's 100 KB per-value cap could cross it and go uncached (slower, not wrong). (4) CSR's cards now sit as two rows of three, and a five-card department keeps a lone card on a second row below 1360px, as CSR did before. (5) Both cache versions were bumped, so the first load of each view after deploy recomputes.
INVARIANTS AT RISK: None — INV-30 bumped and synced in every doc (`summary:v27`, `insights:v27`); durations are parsed from display values (INV-02); only the `Total Calls` source is read (INV-50, pinned); the dept figures are own-queues-only as every other queue figure on these surfaces.
NET SCORE: 1 − 1 = 0 (QCD-F fired in production on every same-department refresh; P6 is new capability and claims no fix; the one new failure mode is risk 3)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard | BLOCKS DEPLOY: N
- Walk the P6 steps of S62 (the card against the Daily Call Queue Report) and S37 (the two trend metrics) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Overview tiles and the manager digest do not show the longest wait; only My Department and Insights do.
- No standard or tint exists for the longest wait (nothing says what "too long" is); the card is neutral and its chip only compares with the prior period.
- The Queue Call Data side panel itself still shows calls / abandoned % / violations only; the longest wait is on the card and in Insights' Queue health expand.
- A five-card department below 1360px still wraps one card onto a second row.

DOCUMENTATION UPDATES NEEDED:
- None — client-ui-conventions (the day-bars bullet, the trend metric list, the busy side panels), fix-history (`P6`), S62 / S37, INV-30 and every version table, the harness README and module-dependencies were updated in this change.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
