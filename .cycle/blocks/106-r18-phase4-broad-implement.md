---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18 item 4a | A light→dark toggle left every dept-page chart painting the light palette, which made the gap chart's zero baseline invisible
- R18 item 8 | The trend Calendar refused the Queue: Abandoned % metric at every window length

Files modified:
- apps-script/department-dashboard/QCDReport.gs
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/script-1-core.html
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/CacheWarm.gs
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/invariants.md, docs/architecture.md,
  docs/conventions.md, docs/known-issues.md, docs/sub-queue-split-plan.md
  (the last five: the `insights:v21`→`v22` cache-pin references the
  cache-version-sync test enforces)

CHANGES:
R18-4a | script-1-core.html | `repaintLiveCharts_` repainted the OVERVIEW chart and returned. Every dept-page chart therefore kept the palette it was BUILT with — Chart.js bakes `THEME.*` at construction — so after a flip to dark it drew light-mode ink on a dark canvas. It now also rebuilds the dept missed chart, `insDrawTrendChart_` and `insRenderCardsChart_` from their cached payloads. Modal charts stay out (they rebuild on reopen).
R18-4a | script-1-core.html | Each surface is guarded three ways, and all three are load-bearing: the renderer must EXIST (fragments load independently), its container must be VISIBLE (`offsetParent !== null` — rebuilding inside `display:none` renders at zero size, the C3 draw-on-open trap), and each is wrapped in its own try/catch so one stale chart cannot block the rest.
R18-4a | (diagnosis) | The symptom is narrower than "dark mode is broken", which is why it read as a CSS bug: only the zero gridline uses `THEME.ink`, so under a stale light theme it is near-black on a near-black canvas while the `THEME.line` gridlines around it stay visible. Measured before the fix, after toggling to dark: zero line rgb(16,20,24) on a rgb(12,15,20) background. After: rgb(236,240,246) — matching a page LOADED in dark. It reproduces on the toggle path only.
R18-8 | QCDReport.gs | `computeQcdReport_` now accumulates `ytdDailySeries` — Jan-1-of-the-end-year daily dept totals, the SAME row shape as the window-scoped `dailySeries` — inside the 12-month trend pass it ALREADY runs. The Phase 3 follow-on had guessed this would need a bigger QCD read; it does not. `computeTrendStartDate_` guarantees the trend window spans Jan 1 of the end year, so the rows are already in hand and this is one accumulator, no extra read and no second query. It is gated on the same `isOwn(callQueue)` as the range accumulator, so "dept total" means the same thing in both series.
R18-8 | InsightsReport.gs | Passes it through as `queueHealth.ytdDailySeries` (plus the empty-shape parity entry) and bumps the cache to `insights:v22` — old blobs have no YTD queue series, so a cached one would leave the toggle dead for the TTL.
R18-8 | script-8-insights.html | `insCalendarUsesYtd_`, `insCalendarEligible_`, `insCalendarIneligibleReason_`, the calendar header and `insRenderTrendCalendar_` all branch on the queue metric and pick the queue series pair over the team pair. The span rule is gone from the queue path entirely; the remaining refusals are ATT, a non-abandoned-% queue metric (both line-only by design) and genuinely having under two days of data — and the tooltip now says that instead of the stale 14-day text.
R18-8 | script-8-insights.html | The queue calendar's header derives its range from the series' OWN first/last row rather than `trendYtd.from/.to`: QCD history need not begin the same day DQE history does, and mislabelling the span is exactly the misreading the caption exists to prevent.
Both | drive-smoke.js | Four new assertions. Queue: the toggle is offered at the dept page's default one-day window, and the grid it draws is captioned as year-to-date. Dark mode: every on-screen dept chart gets a NEW Chart.js instance id after the flip, and comes back carrying dark tokens. The palette is read from `Chart.getChart(canvas).config._config.options` — the RAW config, because `chart.options`' scriptable color resolvers throw without a render context.

TEST RESULTS: passed. `node --test` 671/671; INV-16 green; cache-version-sync + claude-md-split green; `npm run ci:ui` all stages passed (drive-smoke 68 — was 62, drive-f13 16, drive-subqueue 30, drive-devoverlay 14). Worth noting from the smoke output: the repaint assertion reports two rebuilt charts, not three, because the trend canvas is in CALENDAR mode at that point in the walk and its wrap is hidden — the visibility guard doing exactly its job. Verified live before wiring the assertions: the queue calendar renders 30 cells captioned "Apr 8–Aug 11 (year to date)" on a one-day window, and a mode flip rebuilds all three dept charts with `--line` moving #c8d8e6 → #242a34.

REGRESSION RISKS:
- `gen-payloads.js` must be re-run after a server payload change or the harness silently tests the OLD shape. That is what made item 8 look unfixed after the server side was correct: the client gate read a missing field and correctly returned false. Rebuilding the harness site is NOT enough — the payloads are a separate step.
- The YTD accumulator adds one dictionary over rows the trend pass already iterates. It grows the `insights:` cached blob by roughly one row per business day per year (~250), which is well inside the CacheService per-value ceiling the Overview blob (F6, measured ~27 KB) is the only real candidate to approach.
- `repaintLiveCharts_` now rebuilds up to three charts on a mode flip instead of one. Each is a repaint from a cached payload, never a refetch, and each is skipped when hidden.
- No behavior change for anyone who never toggles modes or never opens the queue metric; both paths are additive.

INVARIANTS AT RISK: None. INV-30 is satisfied (`insights:v22` bumped, and the six doc references synced — `cache-version-sync.test.js` fails the build otherwise). INV-42's rule that chart colors resolve through `THEME.*` / `colorToCanvasRgb_` is REINFORCED: the repaint is what makes a correct `THEME` reach an already-mounted chart. INV-51's queue-rollup semantics are untouched — the new series reuses the same `isOwn()` own-queues gate as the existing accumulators.

NET SCORE: 2 production fixes − 0 new failure modes = 2
(4a fired for any dark-mode user who toggled rather than loading dark — the zero baseline vanished on the chart the Insights page leads with. 8 was a capability the owner asked for that the calendar refused at every window a dept actually uses.)

OPERATOR ACTIONS / DEPLOY:
- None new. The Phase 2 action still stands: populate Dept Config "Team Avg Excludes" for other depts with a call-taking manager on the roster | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Owner item 1's SECOND half is not implemented: a Yesterday/MTD toggle on the Team Rings panel. Unlike the Queue Call Data panel — which already carries `mtd`/`mtdPrior` blocks — the rings panel renders DQE data over the selected window and has no month-to-date equivalent in the payload, so this is a data decision, not a layout one. Raising it rather than guessing at the shape.
- Owner items 5 (Sales agent-count overrunning its container), 6 (confirm the Gap-vs-Team colour valence on the Missed metric) and 7 are unaddressed in this phase.
- The R17d team-metric calendar and this queue one now share four decision points but not one function. They agree today; a fifth branch is the moment to extract a single `insCalendarSeriesFor_(data)` that returns the chosen series plus its span.

DOCUMENTATION UPDATES NEEDED:
- DONE: docs/client-ui-conventions.md gained a new bullet for the repaint rule (with the toggle-path-only reproduction and the three guards) and its R17d calendar bullet was rewritten to cover both metric families.
- DONE: the `insights:v22` bump is recorded in INV-30 with its reason.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
