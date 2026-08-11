# Client / presentation-layer conventions

<!-- Split out of CLAUDE.md (finding F8). CLAUDE.md was ~372 KB and is loaded
into EVERY session's context; this file holds the full text of one reference
section so the working document stays readable. CLAUDE.md keeps a one-line
index and a pointer here. The text below is the AUTHORITATIVE version --
the index is a finding aid, never a substitute. Keep them in sync;
tests/unit/claude-md-split.test.js fails the build if they drift. -->

The CLIENT-side conventions that were Common Gotchas bullets in CLAUDE.md:
how the Insights page, the Overview page, the density/prefs layer, the `ds-*`
component system and the design tokens are built. **Read this before touching
`script.html`, any `script-*.html` fragment, `styles.html`, or
`dashboard.html`**, and re-run `npm run ci:ui` afterwards.

## The assembled client (#4, Round-16): script.html + the script-*.html fragments

The client used to be ONE ~21K-line script.html. It is now **script.html (a
~45-line ASSEMBLER) + eleven `script-N-<name>.html` fragments** spliced into
one `<script>` element / one IIFE, in include order, by the
template-EVALUATING `include_` (Code.gs). Everything a maintainer needs:

- **One shared scope, exactly as before.** The fragments assemble into the
  same single IIFE, so function hoisting and top-level `const`/`let`
  visibility span fragment boundaries. Handlers may call anything anywhere;
  TOP-LEVEL code (IIFEs, init expressions) should only call into its own or
  EARLIER fragments — the assembled order is the include order in script.html.
- **Fragments are RAW JS** — no script/style tags, no template scriptlets
  (include_ evaluates templates now, so a stray scriptlet-open sequence in a
  fragment would EXECUTE server-side at render), and never the literal
  end-of-script-tag pattern (closes the assembled block early — the original
  html-include-structure bug class, now reachable from any fragment).
  `tests/unit/html-include-structure.test.js` enforces all three per fragment,
  pins the include list == the `script-*.html` files on disk (both
  directions — a fragment on disk but not included silently DROPS its
  features), and syntax-checks the assembled body via `node --check`.
- **Adding a fragment** = create the file AND add its include line + map entry
  in script.html (the parity pin fails until you do both). Appending to the
  END of the last fragment is safe — it lands inside the IIFE.
- **`tools/ui-harness/build-harness.js` resolves the nested includes itself**
  (`resolveIncludes_`), so the rendered-UI gate boots the same assembled
  client the real page serves.
- **Deploy note:** `clasp push -f` picks the new files up automatically; no
  web-editor deletion was needed (script.html itself remains, as the
  assembler — INV-17 concerns REMOVED files only).
- The fragment map (name → contents) lives in script.html's header comment —
  that comment is the canonical index; keep it current when fragments change.

These moved because they describe HOW A SURFACE IS BUILT rather than a trap that
bites unrelated work. The client traps that CAN bite you without warning stayed
in CLAUDE.md's Common Gotchas and are NOT repeated here -- `safeChart_`,
`dsConfirm_`, `csvSafeCell_`, the datalabels registration, the OKLCH/datalabels
fillStyle rule, and the `</script>`-in-scriptlet escape. Check those there.

## Insights page

- **The Insights report ABSORBED BOTH the Performance Report AND
  Compare Ranges (each RETIRED)** -- the report-consolidation thesis
  landed: Individual + Insights are the two agent reports.
  **CR's views in Insights:** arbitrary two-window comparison =
  Compare against -> Custom prior range (or YoY); the explicit
  prior values = hover tooltips on every card delta badge
  (`insDeltaBadge_` third arg); the length-mismatch banner/per-day
  columns were already shared (INV-35). (CR's per-agent P1-vs-P2
  grouped bars briefly lived on as a third "vs Prior" cards-chart
  basis, RETIRED by owner note post-conversion -- the 3-way
  sub-selector read as confusing; the remaining Gap-vs-team /
  Absolute options render as two-line `seg-rich` choices, and a
  saved 'prior' pref restores as 'gap'.) Deliberately NOT carried over:
  floater cards (Insights is roster-only, insights v15 -- floaters
  proved to be false positives in prod; IR still surfaces them).
  Legacy `#/report/compare` deep links land on Insights (page
  repoint); `CompareRangesReport.gs` was deleted (the shared
  `deltaClassify_` / `deltaImprovementScore_` / `deltaIsQuiet_` /
  `crFormatSecondsShort_` client helpers were re-homed to a shared
  block in script.html -- Insights consumes all four).
  `InsightsReport.gs` = PR's team rollup + CR-style
  per-agent delta cards + the 12-mo trend, with comparison modes
  (auto-adjacent INV-28 / YoY / custom) resolved client-side to
  explicit priorFrom/priorTo. The old live parity test became the
  consolidation-FREEZE test (insights-report.test.js): it pins the
  inherited INV-25/28/29 semantics as fixture literals -- if it breaks,
  Insights has diverged from what managers were promised at the PR
  fold-in. PR's three views all live here now: the ds-kpi rollup
  tiles, the share-of-answered donut (`insRenderShareChart_`), and the
  Volume & Efficiency stacked bars as the per-agent Chart view's
  **Absolute** sub-toggle (`insRenderCardsChartAbs_`; 'gap'|'abs'|'trend' in
  `insCardsChartMode`, persisted in prefs; the metric selector shows for
  gap + trend, hidden for Absolute). **The per-agent Chart view has a third
  basis, Trend (R11-E4, `insRenderCardsChartTrend_`):** one LINE per selected
  agent for the chosen metric (% Answered / Answered / Missed / Rung) over the
  12-mo axis (`trendData.labels`), from the per-agent `trendMonthly` series
  the server now sends; it reuses the Overview `chartSpotlight*` model
  (legend hover-dim, click-pin/solo, Shift/Cmd/Ctrl add, Alt-hide) and
  point-clicks drill into that agent's IR. **The donut shows TRUE dept shares
  (R11-E6):** slices divide by `meta.answeredDeptTotal` (the whole dept's
  answered, all active roster agents, current window) and the unselected
  agents fold into a muted "Other agents" slice, so an agent's share is
  identical whether the report runs for the whole dept or a subset (it was
  previously a share of only the selected agents' answered). **IR hover-prefetch:** resting the pointer ~300ms on an
  agent card fires that agent's `getIndividualReport` (the drill's
  exact request shape) and seeds the D1b keep-last-good store, so the
  click-drill SWR-paints instantly -- one intent-gated speculative call
  per (dept, window, agent) per session, never a preload-all (quota +
  contention); prefetches count in Report Usage telemetry (the
  signature must match exactly, so no marker param is possible). Insights also carries a
  **Queue health** section (`queueHealth` in the response, rendered
  by `insRenderQueueHealth_`): queue-level tiles + per-queue rows with
  violation dates for the same window + prior window, computed by the
  SAME `computeQcdReport_` the retired QCD modal used (null/hidden when
  unmapped or the QCD sheet is missing; `{error:true}` -> a small
  "unavailable" note on a genuine compute failure, F8) -- the consolidation path
  toward Insights replacing QCD for day-to-day use, with the QCD
  Report remaining the deep dive (per-queue charts, daily series).
  **Phase 2 parity (heatmap + agent-free run, commit c7b6b06):** Insights
  now also renders the temporal abandon **heatmap** (`#ins-heatmap`,
  admin-only, reusing `getInboundHeatmap`) as a Queue-health companion,
  and can be generated **agent-free** -- an EMPTY agent selection defaults
  to the full dept roster (the digest pattern, INV-45; floaters excluded)
  via the shared `resolveInsightsAgents_` used by BOTH `getInsightsReport`
  and `sendInsightsReportEmail`, so a manager can open Insights as a queue
  / dept dashboard without first picking agents. The non-empty path is
  byte-equivalent to the dedup loop it replaced; the only remaining throw
  is a genuinely empty roster. Client: Generate is enabled whenever the
  roster is non-empty (`insUpdateGenerate` counts `.ir-agent-cb`, not
  `:checked`), and the picker hint advertises the whole-department view.
  **No cache bump** -- `meta.agents` already carried the resolved selection,
  so agent-free is byte-identical to explicitly selecting the whole roster
  (deterministic per `hashAgents_` key; no bump was needed for it). The QCD
  tab/modal/`getQcdReport`/`getQcdReportInit`/`sendQcdReportEmail` were
  RETIRED after the parallel run (the QCD->Insights consolidation):
  `#/report/qcd` deep-links repoint to Insights, the "abandons"
  quick-start chip (Help modal since R10-1) opens Insights, and the per-dept `qcd:` cache prefix is
  gone. KEPT: `computeQcdReport_` (Insights Queue health + snapshots),
  `getQcdAllDepartments` (`qcdAll:`), and the two snapshot paths. An
  UNMAPPED dept now renders its "no queues mapped" hint (+ admin Dept
  Config CTA) in Insights Queue health (`queueHealth.unmapped`, v18);
  the Insights by-queue chart gained the retired chart's violation-day
  warn markers + legend spotlight.
  **Chart consolidation (seq #1, the insights v7 bump):** the 12-mo team-trend
  chart and the queue-health abandoned-% chart are ONE tabbed chart
  (`insRenderTrendChart_` on `ins-trend-chart`). **Since R11-C3 the metric
  sub-tabs + the per-queue metric select + the calendar's cell-metric
  segment are consolidated into ONE `#ins-trend-metric` dropdown** (owner:
  "too many selectors"): Answered / % Answered / Missed / Call volume
  (rung) / Avg talk time (ADMIN-only -- the `data-admin-metric` option is
  REMOVED at init for non-admins, since `<option>` can't use the
  data-admin-only reveal) / the queue metrics as `queues:<metric>` values
  (Abandoned % / Total calls / Violations -- these split into the old
  queues tab + `insQueueMetric`). Plus a **Monthly/Daily**
  toggle (`insTrendView`), hidden in Calendar mode. Daily for the team metrics reads the
  `trendDaily` response field (daily answered/missed/rung/%/ATT over the selected
  window); Daily for the queue tab reads `queueHealth.trend.daily*`.
  `queueHealth` now ALWAYS-separates sub-queues (children shown as
  their own lines/rows + tagged `subDept`, EXCLUDED from the own-only
  dept total) -- the old `ins-qh-include-sub` toggle + the
  `queueHealthOwnOnly` request flag are retired (mirrors the QCD
  report's seq-#5 separation). The Queue health section keeps its
  tiles + per-queue detail table. **Trend-point drill:** clicking a
  data point on ANY tab of the consolidated chart re-runs Insights
  scoped to that bucket -- a month on Monthly, a single day on Daily
  (`insTrendPointDrill_`: requires an actual point hit, Overview-chart
  convention; syncs the form dates, keeps agents + compare mode, goes
  through `runInsReport`; monthly 'MMM, yy' labels are parsed
  client-side, team-daily 'MM-DD' labels re-derive their year from the
  selected window). **Violation-date drill:** in the Queue health
  per-queue expand, violation dates render as chips that open the
  collapsed Daily breakdown, scroll to, and flash that day's row
  (`insJumpToDailyRow_`; daily rows carry `data-date`). Per-agent classification
  / improvement score / quiet thresholds are the SHARED
  `deltaClassify_` / `deltaImprovementScore_` / `deltaIsQuiet_`
  helpers in script.html (CR delegated to the same ones). **All
  classification inputs are PER-WORKING-DAY-adjusted first**
  (`insPerDayMetrics_`, owner note): the volume metrics
  (rung/missed/answered/ttt) have their deltaPct recomputed on
  per-working-day values using `meta.currentWorkDays`/`priorWorkDays`
  (INV-35's `countWorkingDays_`, holidays excluded), so a shorter or
  holiday-bearing window can't brand an agent "▼ Slipping" on raw
  counts alone; rates (pct/att) and equal-workday comparisons are
  unchanged, and the card DELTA BADGES keep showing raw window totals
  -- only the trend pill / triage / quiet / improver-sort / headline /
  CSV classification columns consume the adjusted values.
  **Per-agent cards (seq #3, redesigned in the post-deploy pass):** each
  card leads with **% Ans / Answered / Missed** as CSS bars **vs the TEAM
  AVERAGE** (a marker on each track) + the agent's value in a right-aligned column beside each track (moved off the bar in #3 so it never overlaps the team marker)
  (`insBuildCard_` builds them; the team average per metric is computed in
  `insRenderAgentCards_` as team-total / `meta.rosterAgentCount`, except
  `pct` which is the team rate). Rung / ATT / TTT moved into a collapsible
  `<details>`. The toolbar has a **Cards⇄Chart** toggle (`insCardsView`):
  Chart view (`insRenderCardsChart_` on `ins-cards-chart`) renders each
  agent's **gap vs the team average** as diverging bars (colored by
  favourability -- Missed is inverse), value as a datalabel, **click a bar
  to drill into IR**. Both views persist in `cdr.ins.prefs`; single-agent
  reports force Cards view. **IR drill-through (`irDrillToAgent_`):**
  Insights is a full PAGE (modal->page conversion,
  docs/insights-page-plan.md), so the IR modal simply OVERLAYS it -- the
  rendered report stays put behind the overlay, nothing is hidden or
  re-shown. The drill detects its origin via `data-page === 'insights'`,
  opens IR, and reveals a **"Back to Insights"** button
  (`ir-back-to-insights-btn`) while HIDING IR's generic "« Back"
  (`ir-back-btn`, the return-to-setup-form button) for the drill's
  duration -- two Back buttons side by side read as redundant, and during
  a drill "back" means Insights; IR `closeModal`'s `irCameFromInsights_`
  branch restores the buttons, and ANY close (Back / X / Escape) reveals
  the intact page -- instant, no re-generate (the server cache
  `insights:v19` already makes a fresh re-generate fast too).
  **Insights in-results edit popover:** the Insights results header carries
  the same editing line + `change` popover IR has (`#ins-edit-popover`;
  `insOpenEditPopover_` / `insApplyEditPopover_`), so dates / comparison /
  agent selection can change without a round-trip through the setup form.
  Two Insights-specific semantics: Apply allows an EMPTY selection (=
  whole-department agent-free run, INV-45 -- "Select none (whole
  department)" is a feature, Apply is never disabled; the popover
  pre-checks the REQUESTED agents via `insLastRequestedAgents_`, not the
  server-resolved `meta.agents`, so an agent-free run stays agent-free),
  and the compare control defaults to a `keep` sentinel that re-resolves
  through the MAIN form's compare mode. Since the setup-form retirement
  the popover can also EXPRESS a custom prior (Compare=custom reveals
  Prior from/to inputs, prefilled from the last-used custom window) --
  it's the only editing surface now. Apply syncs the popover back into
  the HIDDEN setup form (still the state store the launcher / share-state
  / prefs read), then reuses `runInsReport()` (SWR + D1b + stale-guard).
  The popover expands DIRECTLY beneath its button, above the headline
  banner -- `reportHeadline_`'s insertion-anchor loop skips
  `.ir-edit-popover` siblings (like `status`/`ir-loader`/`empty-state`)
  so the headline lands AFTER the popover in DOM order (owner note: it
  previously wedged between the header and the popover). The results
  date line labels the window so it doesn't read as arbitrary: it
  appends "last 30 days" when the range matches the launcher default
  and always appends the workday count ("· N workdays",
  `insWorkdaysLabel_` -- server `meta.currentWorkDays` preferred, client
  `workingDaysBetween_` fallback); the compare line appends the PRIOR
  window's workdays likewise. The team
  rollup tiles dropped Total Rung / Total TTT; Queue health dropped Longest
  wait (decluttered to two labeled groups: Department rollup + Queue health).
  The rollup's rate tile is labeled **"% Answered (rings)"** (owner note):
  it's answered ÷ rung, and rung counts RINGS -- one call can ring several
  agents -- so it's ring-level, not share-of-unique-calls; the glossary
  carries a matching `'% answered (rings)'` entry (plain + rich).
- **Insights window controls, trend-at-bottom, and the Insights<->My-Department
  hand-off.** (1) **Window controls (Round-16 Phase 2 -- superseded the I4
  period slider):** see the Round-16 section's "Insights header = the My
  Department controls pattern" bullet; the WHOLE results header (title +
  toolbar + the From/To controls row) is the page's sticky strip, mirroring
  the My Department controls row -- both pin via `position:sticky; top:0` on
  an opaque strip (styles.html R9-1/R11-B9 block) with the Phase 3
  elevation-on-stuck shadow. The **12-mo team-trend
  chart lives at the BOTTOM in its own "Trends" section** (now a Round-16
  FOLD; drawn on open) -- it's the one view the window controls don't govern
  (always ~12 months); the share tally stays deferred inside Team-detail
  (`insRenderDeferredCharts_` is share-only now). NB since R11-C3 the
  by-queue metrics are entries in the ONE `#ins-trend-metric` dropdown
  ("Queue: Abandoned %" etc. -- internally `data-metric="queues"` +
  `insQueueMetric`; the old sub-tab row + queue select are retired).
  (2) **Hand-off (the department is the shared global
  selector, so only DATES are carried):** `handoffToInsights_(from,to,scroll)`
  (a parametrized `launcherOpenInsights_`) and `handoffToMyDept_(from,to,{missed})`
  (mirrors `launcherOpenMissed_`; `missed:true` arms `deptMissedScrollPending_`).
  Round-16: the LENS SWITCHER (see its bullet below) is the visible route in
  both directions -- the `#dept-insights-strip` teaser strip that used to
  render beside `renderDeptTeamStrip_` is RETIRED with its `.dis-*` CSS
  (the team strip itself is unchanged: "% Answered (rings)" labeling, the
  R10-5 Avg answer + CSR Transfer % tiles, R11-C1 delta chips --
  summary:v19). Insights' Queue-health **"See missed calls ->"** drill
  (-> `handoffToMyDept_`) is wired in `initInsightsReport`. **R9-3 shared date window (client-only, no
  server/cache change; SUPERSEDED the Batch-E "Use these dates" offer
  chip):** the hand-off buttons carry a window only when you explicitly
  cross over; the plain NAV-TAB path now SILENTLY converges --
  `adoptSharedWindow_(page)` (called from `setPage`'s `dept`/`insights`
  branches) compares the two pages' last-rendered windows
  (`pageActiveWindow_`, recorded WITH a timestamp in `refresh()` and
  `insSyncPeriodBar_`) and, when the OTHER page's window is the more
  RECENT one and differs from this page's inputs, rewrites the entered
  page's date inputs and re-runs (dept: the setPage refresh branch;
  Insights: `runInsReport`, or the first-entry pending auto-run just reads
  the rewritten inputs). Newest explicit choice wins wherever it was made,
  so the two pages feel like one top-line date strip (owner feedback,
  post-deploy R9). The `.dsync-chip` markup/CSS,
  `maybeShowDateSyncChip_`/`applyDateSync_`, and the dismissal memo are
  all retired. **#5 Option A hover-prefetch (client-only):** the cross-page
  hand-offs that land on My Department -- the Insights **"My Department ->"**
  button + Queue-health **"See missed calls ->"** link (delegated ~300ms
  hover intent on `#insights-page`) -- warm My Department's summary
  for the target window via `prefetchDeptSummary_` (one `getDepartmentSummary`
  call, `req={department,from,to}`, seeded into the D1b store under the
  `'summary'` key so `refresh()`'s SWR paints instantly on click). Guards
  mirror the IR hover-prefetch: one fetch per signature per session
  (`deptSummaryPrefetched_`), skipped when the store is already warm,
  best-effort (a failed prefetch is silent). ONLY the My-Department direction
  is prefetched -- the Insights direction's request signature (agents +
  compare mode + resolved prior window) isn't reliably known at hover time,
  so it's intentionally left cold (a sig miss would just waste the call).
  Like the IR prefetch, a warmed summary is a real endpoint call, so Report
  Usage telemetry counts it. (3) **Chart->Missed drill-down slice
  (Phase 1):** `MissedCallsReport.gs::getMissedCallsSlice` -- a read-only RPC
  (auth identical to `getMissedCallsReport`: signed-in + `assertDeptAccess_`)
  returning the SAME per-call Missed detail `computeMissedCallsReport_`
  produces, narrowed IN MEMORY by `{isoDow, hourStart, hourEnd (CST), agent,
  queue}` (pure `missedSliceFilter_` + `missedSliceValidateFilter_` +
  TZ-safe `missedSliceIsoDow_`; `missedReportDataCached_` shares the section's
  `missed:v17` cache). It is the **DQE missed-ring lens** the heatmap cell
  drill + Queue-health hand-off will surface as a SEPARATE, LABELED lens: the
  three drill surfaces count DIFFERENT things and DON'T reconcile (heatmap =
  `inbound_calls` abandons, Queue health = `qcd_history` roll-up, missed bar =
  `dqe_history` rings -- the parked QCD-vs-inbound discrepancy). **Owner
  rulings: two labeled lenses (never silently swap the count) + an in-place
  overlay.** Phase-1 limit: the `queue` filter narrows the queue-only section
  only (agent rings aren't queue-tagged). **ALL FOUR PHASES ARE SHIPPED**
  (R8-E6 doc fix -- this bullet previously claimed the endpoint was
  dormant): Phase 2's bucket-detail journey chips were already present
  (`parentIdBadge` emits `.pid-journey`); Phase 3 is the Queue-health
  per-queue "↳ no-ring abandons (DQE missed lens)" in-place drill
  (`insQhMissedDrill_`, served instantly by the `insQhNoRingGate_`
  whole-window prefetch); Phase 4 is the heatmap cell drill's TWO labeled
  lenses (`heatCellToggleDrill_`: inbound abandons + DQE missed rings via
  `missedSliceHm_` slot geometry; shared renderer `missedSliceListHtml_`).
  The full design + owner rulings live in
  **`docs/insights-drilldown-spec.md`**. Pinned by
  `tests/unit/missed-slice.test.js`.
- **(RETIRED, Round-16) Insights Simple/Detailed density toggle (D1-D3)** --
  the mode is replaced by the per-section FOLDS (see the Round-16 section's
  bullet, which carries the live rules: fold state, role seeds, the density
  pref migration, and the C3 lesson re-expressed as draw-on-open). Kept
  here: the **C3 chart trap itself is timeless** -- never render-then-hide
  a chart (`insDrawTrendChart_` gives up after 30 hidden frames); build on
  expand instead. Companion D2/D3 pieces STILL LIVE: the edit
  popover's compare/prior/agent controls live behind an **Advanced
  options** `<details>` (`#ins-edit-advanced`, field IDs unchanged;
  auto-opens when the current report uses a custom prior or a partial
  agent selection); a first-run intro card
  (`#ins-intro-card`, localStorage `cdr.ins.intro.v1` -- since R7/I-3 it
  shows ONCE, period: the first render auto-marks it seen, no click
  required; the dismiss button still hides it immediately); the #6 all-clear
  headline line (renders only when NO agent is behind team AND
  |team pct delta| <= `INS_ALLCLEAR_MAX_PTS_`=1.5 pts); and the #7
  small-sample guard (`INS_SMALL_SAMPLE_PER_AGENT_`=10 avg answerable
  calls/agent -- a note + muted delta pills, display-only, never hides
  data).
- **Insights density Phase 2 (#8/#9/#10) — saved views, share link,
  calendar trend, summary email.** All presentation/plumbing on existing
  contracts. (#8) The results header's **Views** menu (`#ins-views-btn`)
  holds PERSONAL named saved views (localStorage
  `cdr.ins.views.v1:<email>`, max 12; snapshot = the SHARE_STATE_
  provider's state: dates/compare/custom-prior/agents (''=whole dept)/
  Simple-Detailed — NOT the department) + **Copy share link**, which
  reuses the existing `#/report/insights?…` deep-link machinery
  (`encodeShareParams_`), so an opened link runs the normal auth+fetch
  path and can never grant an unentitled dept. The Insights SHARE_STATE_
  provider is WRAPPED to carry a `view=simple|detailed` param
  (density restores from links/views). Applying a view re-checks the
  already-rendered picker directly (the pending-selection hook only
  fires on a roster render); a view with no agents param UNCHECKS all
  (agent-free semantics preserved). (#10) The trend chart gains
  a **Line ⇄ Calendar** renderer toggle (`insTrendRender` in prefs):
  Calendar is a Mon–Fri day-grid second
  RENDERER of the same `trendDaily` series (no server change), cells
  colored by the existing benchmarks (Answer % vs the 92% target;
  Missed / Call volume / Answered as intensity ramps) with the number
  in-cell, per-day
  click-drill via the shared `insDrillToRange_` (extracted from the
  trend-point drill); eligible for 14–366-day windows
  (`INS_CALENDAR_MIN/MAX_DAYS_` — the MM-DD daily labels must stay
  unambiguous), Detailed-only by construction (the whole trend hides in
  Simple). **Calendar v2 (R7/I-1):** one MONTH renders per view with
  ‹ › month pagination (`insCalMonth_`, defaults to the MOST RECENT
  month, resets on window change — the old all-weeks render CLIPPED
  past month 1 inside the fixed-height chart wrap, which calendar mode
  now also releases via `.ir-chart-wrap--cal`); an **'Abandoned %'**
  cell rendering (dept-total daily abandoned % from
  `queueHealth.dailySeries`, colored on the 5% standard) makes the
  Queue: Abandoned % metric calendar-eligible too; and the
  Line⇄Calendar toggle stays VISIBLE but disabled with a reason
  tooltip (`insCalendarIneligibleReason_`) on ineligible metrics/windows
  instead of vanishing (the discoverability fix — it used to hide
  entirely, which read as "the calendar view is gone"). **Since R11-C3
  the calendar has NO metric selector of its own** — the cell metric is
  DERIVED from the ONE `#ins-trend-metric` dropdown
  (`insActiveTrendMetric` → ans/pct/missed/vol, or abd for Queue:
  Abandoned %; a muted `.ins-cal-metric-lbl` label names it in the
  toolbar; the old per-calendar segment + the `insCalMetric` pref are
  vestigial). Calendar-capable metrics: Answered / % Answered / Missed
  / Call volume + Queue: Abandoned %; ATT and the count queue metrics
  stay line-only (`insCalendarEligible_`). The Monthly/Daily toggle
  hides while Calendar is active (a calendar is inherently daily), and
  the calendar's day-drill + month-nav clicks are wired DIRECTLY on the
  rendered nodes each render (belt-and-braces after the delegated
  handler missed on some paths — the reported day-click no-op).
  **R16g: a calendar day-click JUMPS to the Daily breakdown instead of
  reloading the region for that one date** (the reload left the page's two
  halves on conflicting windows). `insCalJumpToDaily_` opens the Queue-health
  fold + the daily `<details>`, expands the date's day group
  (`insJumpToDailyRow_`), and inserts the per-DATE drill row
  (`insQhDayDetail_` → `getMissedCallsSlice` with from=to=the date, no
  dow/hour filter — every missed ring + queue abandon for the day, rendered
  by the heatmap drill's `missedSliceListHtml_` so the 🚨 + "↳ path" chips
  ride the existing `.pid-journey` handler). The detail row joins the day
  group's open/close (the `insQhDayToggle_` selector covers all three row
  kinds). Falls back to the old single-day reload ONLY when the daily table
  can't take the jump (no QCD daily rows / date outside the series).
  **R16h: the trend LINE chart's point-drill joins it** — a point that
  resolves to ONE day (`range.from === range.to`, i.e. Daily mode) jumps like
  the calendar; a MONTHLY point spans a month the day drill cannot represent,
  so it keeps the re-run. **R16h also gives the drill TWO labeled lenses**,
  the heatmap-cell-drill shape: DQE missed RINGS (time · agent · path) beside
  inbound ABANDONS (wait/hold seconds · entry→final queue · stage · path).
  They answer different questions from different sources and are not expected
  to reconcile. **R16i: BOTH lenses are manager-reachable.** The abandons lens
  calls `getDeptDayAbandons` (Inbound&nbsp;Report.gs) — one date, one required
  and access-checked dept, no company view, the call list only — NOT the
  admin-gated `getInboundHeatmapCell`. The two share `inboundAbandonList_`, so
  the AUTH decision lives in each public function while the DEFINITION (what
  counts as an abandon, which hours, which dept, the 200 cap) lives in one
  place. The payload carries `meta.reconcileNote`, rendered by
  `heatCellDetailHtml_` whenever present: this list sits directly beneath a
  QCD-sourced abandoned count and the two differ by definition, so the
  explanation ships WITH the data rather than being opt-in per call site. (#9→R16c) the separate **Email summary** is RETIRED —
  `sendInsightsReportEmail` sends ONE consolidated email (a legacy
  `style` param is ignored): takeaway + rollup tiles + the behind-team
  block (`insEmailBehindBlock_` — answer rate below the team average, min
  `INSIGHTS_EMAIL_MIN_CALLS_`=10 answerable calls — a PLAIN DEFINITION,
  deliberately not a replica of the client tier classifier) + the
  per-agent table filtered to agents WITH activity (the legend counts the
  hidden). NB the manager DIGEST's insights format reuses
  `insEmailReportRows_`, so it inherits both; same auth,
  same compute, same caller-recipient as the full email.
- **Guided onboarding tour is client-only (#5).** A self-built
  coachmark walkthrough (no dependency): `initTour_` / `startTour_`
  in script.html + `.tour-*` styles. Spotlight = a `#tour-highlight`
  box with a huge `box-shadow` that dims everything else (click-through;
  only the `#tour-tip` card is interactive); reduced-motion aware.
  Steps (`tourAllSteps_`) anchor to stable IDs (`#page-title`,
  `#freshness-pill`, `#ov-trend-chart`, `#ov-period-bar`,
  `#my-dept-btn`, `#escalations-btn`,
  `#reports-menu-btn`, `#help-fab` -- the `#ov-launcher` step folded
  into the Help closing step when R10-1 moved the quick-start chips
  into the Help modal; the Insights step folded into the My Department
  step when Round-16b retired the top-nav Insights tab) and `tourVisibleSteps_` drops any
  target that's missing or hidden (so admin-only/not-yet-rendered
  elements are skipped gracefully -- e.g. the freshness pill before
  data loads, or -- since Batch F added the `#ov-trend-chart` /
  `#ov-period-bar` steps, both inside the data-gated `#ov-body` -- those
  two on a cold first load before the Overview payload reveals the body;
  they always show on replay + warm loads, the established freshness-pill
  pattern). The nav-button step bodies also describe the newer per-page
  surfaces they open (My Department's team strip + range Queue tiles +
  inline Missed report; Insights' header date controls + the R9-3 shared
  date window) since those live off the Overview landing and can't be their
  own visible steps. Auto-runs ONCE for first-time visitors (localStorage
  `cdr.tour.done`, gated to the Overview landing, 1.2s after load) and
  is always replayable from **Settings -> "Take the tour"** (`#tour-replay-btn`
  lives in the Settings modal, dashboard.html; the replay handler closes the
  SETTINGS modal via its own close button -- the F-42 focus-trap discipline --
  before starting the tour, C-2) **and, since R10-1, from the Help modal's
  `#help-tour-btn`** (same close-then-start discipline; the tour's closing
  step always pointed users at Help, so the button now exists there). No server endpoint / cache bump -- part of
  the same client-only anti-intimidation layer below.
- **Insights floating admin A/B remote is client-only (R11-J).** A small
  collapsible fixed card (`#ins-ab-panel`, bottom-right above the Help FAB)
  for live A/B testing of the four Insights view toggles -- Agents Cards/Chart,
  chart Basis Gap/Abs/Trend, Trends Line/Calendar, and the trend Metric select.
  It's a REMOTE, not a parallel state: each button FORWARDS a `.click()` to the
  real segmented control (`ins-cards-view-toggle` / `ins-cards-chart-mode` /
  `ins-trend-render-toggle`) and the select mirrors `#ins-trend-metric`, so all
  existing state/prefs/render wiring fires ONCE; `insSyncAbPanel_` (called from
  `insApplyCardsView_` + `insRenderTrendChart_`) reflects live state +
  calendar-eligibility back onto it. Admin-gated via `data-admin-only`; it lives
  INSIDE `#insights-page`, so it auto-hides on every other page and during
  view-as-manager; hidden ≤900px. It changes ONLY the admin's own view (their
  `cdr.ins.prefs`), never another user's -- it is not a way to set a global
  default. No server endpoint / cache bump.
- **Anti-intimidation layer is client-only; keep it that way.** Four
  pieces, all in script.html/styles.html with no server endpoints or
  cache bumps: (1) **answer-first headlines** -- every report's results
  open with 2-3 plain sentences via `reportHeadline_` + per-report
  `*Headline_` composers (each guards its no-data case). **R11-M: a
  per-user Settings toggle ("Show report summary banners", localStorage
  `cdr.headlines`) hides ALL `.report-headline` banners via `body.headlines-off`
  for users who find the tone distracting; the `report-headlines` UI flag is
  the admin-global equivalent.** The headline is
  a STATUS-TONED banner (redesign): a composer may return
  `{sentences, tone}` instead of a bare array, where `tone` comes from
  `headlineTone_` using ONLY the two company standards -- the ANSWER TARGET
  (seed 92%, admin-tunable via ANSWER_TARGETS, Op State #37) and the fixed
  5% abandon threshold (answer >= target -> green "On track"; answer <
  target OR abandon >=5% -> orange "Watch");
  absent metric / bare-array return -> neutral "At a glance". Wired for
  Insights (team answer rate) + Inbound (abandon/answer);
  Missed + comparison-mode stay neutral. **EXCEPTION (IR1): the Individual
  Report (single agent) uses `irHeadlineTone_` instead -- PEER-AWARE:
  agent >=92% -> "On track"; below 92% but AT/ABOVE the team avg -> NEUTRAL
  (owner ruling: beating a struggling team isn't "Watch"); below the team
  avg -> "Watch". So an above-team agent under 92% no longer reads red.**
  `.report-headline.is-good`/
  `.is-warn` tint the box + badge. (2) **Quick-start
  question launcher** (`initOverviewLauncher_`) -- the four question
  chips live in the HELP MODAL's `.help-quickstart` strip since R10-1
  (`#help-launcher`, injected from the one `launcherRowHtml_` builder;
  clicking a chip closes Help via its own close button -- the F-42
  focus-trap discipline -- then navigates). They previously rendered
  pinned atop all three pages; the owner moved them for screen space.
  Three chips route into Insights ("team lately" ->
  the rollup tiles, "abandons" -> Queue health, "agents struggling or
  improving" -> the per-agent cards -- REPOINTED from the Individual
  Report's primed setup form, owner note; IR stays reachable via the
  Reports menu + card drills); each landing scrolls to and briefly
  SPOTLIGHTS its section (`qsSpotlight_` + `.qs-spotlight` accent-ring
  pulse, reduced-motion aware, consumed one-shot via `insScrollPending_`
  at the end of `insRenderReport_`). Insights auto-runs via the one-shot
  `insLauncherAutoRun_` flag consumed in `insRenderAgentList` (the
  race-free post-roster point); the Missed chip sets the page dates to
  the latest DQE date, opens the dept page, and arms the one-shot
  `deptMissedScrollPending_` scroll+spotlight (the standalone Missed
  Calls modal is retired -- the inline section is the report). (3) **Metric glossary** -- `METRIC_GLOSSARY_` is the ONE
  place metric definitions live; `initMetricGlossary_`'s debounced
  MutationObserver applies them as `title=` to `th` + KPI-label
  elements + adds `.gloss` (which renders a circled-`i` `::after`
  indicator that FADES IN on hover/focus only -- not always-on -- via
  opacity so revealing it never shifts the label). A styled,
  ACCENT-BORDERED popover (`initGlossTooltip_` -> `.ds-tooltip`, border
  `var(--accent)`) replaces the unstyleable native `title=` tooltip on
  hover: one shared element, positioned via event delegation, reads the
  def from `title` and stashes it in `data-gloss` while shown to suppress
  the native popover (restored on leave -- the applier skips `data-gloss`
  elements so it can't re-add the title mid-hover). High-value terms
  (% answered / abandoned % / ATT / violations / TTT) get a RICH variant
  from `METRIC_GLOSSARY_RICH_` -- a bold title + def + an optional
  92%/5% benchmark chip -- stored on `data-gloss-rich` and rendered via
  innerHTML (dev constants only); `show()` prefers it + toggles
  `.ds-tooltip--rich`, else falls back to the plain-text `title`.
  Non-`.gloss` native `title=` tooltips (header buttons etc.) stay native.
  Add new terms to `METRIC_GLOSSARY_` (and a rich entry to
  `METRIC_GLOSSARY_RICH_` if it's a standards metric), NOT as inline
  `title=` in render code (the applier never clobbers an existing title,
  so per-callsite titles would shadow the dict). (4)
  **Benchmark tints** -- `benchValueCls_(label, formatted, symmetric,
  surface?)` applies the ONLY two company-wide standards: the answer-rate
  TARGET (-> `.bm-target` sage; seed 92%, ADMIN-TUNABLE via the
  `ANSWER_TARGETS` Script Property -- Alerts modal "Answer-rate
  standards", Op State #37 -- with per-surface overrides `direct` /
  `inbound` for the two reports whose answer rates are different call
  populations; read through `answerTarget_(surface)` client-side /
  `getAnswerTargets_()` server-side, NEVER a literal 92) and the FIXED
  5% abandon threshold (-> `.bm-over` warn; baked into the QCD
  Violations history written at import, INV-50 -- never tunable) on KPI tile
  values (IR/Insights/Inbound) + inbound abandon-% cells. Default
  is BINARY (highlight only the notable direction -- tables, IR tiles).
  The `symmetric` flag (passed `true` by the ds-kpi tiles -- `dsKpiTile_`,
  `crTeamTile_`, `inboundKpiTile_`) tints BOTH sides of the SAME 92%/5%
  standard, so a below-target answer rate reads orange "watch" and a
  healthy abandon rate reads green instead of plain black. Still no
  invented thresholds (only %-formatted answer/abandon values tint;
  counts/durations stay neutral); dept-specific alert thresholds stay
  with the Alerts engine. The bm-* tint wins on `.ds-kpi__value`/`__foot`
  via the two-class overrides in `styles.html` (the ds-* layer lands
  after `.bm-target`/`.bm-over`).
- **Deep-linking to a specific department: `#/dept?dept=<name>`.** The Daily
  Call Queue Report email hangs this on each department's banner line so a
  recipient lands on THAT dept's My Department page. **It is not a security
  boundary and must not be read as one** -- `assertDeptAccess_` gates every
  report endpoint server-side and rejects a dept outside `user.departments`
  whatever the client sends. What the client's `SHARE_STATE_['/dept']` provider
  adds is graceful failure: a dept the viewer does not hold is IGNORED and they
  land on their own, rather than being shown a server error for a link they were
  emailed -- and the queue report's subscriber list is not the Access Control
  roster, so that case is expected rather than exceptional. Matching is EXACT
  (INV-04); the dept is `encodeURIComponent`-ed because names carry spaces and
  `&` (`Eligibility MM&R` would truncate otherwise). A single-dept manager has
  no selector, so it is a no-op for them either way.
- **The sub-queue scope SWITCHER is retired; the group header is the control.**
  A parent dept's My Department table is always the combined view, grouped per
  dept, and each group's heading row toggles its agent rows. Collapsing KEEPS
  the department's subtotal on screen -- that is the whole point of the
  disclosure, and it is what made the tabs redundant: "<dept> only" is the
  combined view with the sub-queue collapsed. The tabs cost a server round trip
  per view to show the same thing, and put the reader in a mode they had to
  track. Default is EXPANDED (nothing hidden on open); state persists per parent
  in `cdr.dept.subqcollapse`. The client no longer sends `subScope`; the server
  still honors it. A sub-queue's group header also carries the ONLY route to its
  own missed calls (Phase 3 cannot merge that section without double-counting
  queue abandons) -- the button re-scopes the section and the scope note offers
  the way back. `cdr.dept.subscope` is an orphan key, swept on load by
  `sweepOrphanPrefs_()` (#5, Round-16) -- read-before-remove, so the steady
  state stays write-free (the objection that previously kept it in place).
- **A control whose only state is a class is a control with NO state, and a
  driver that asserts the class cannot tell the difference.** The retired tabs
  carried `is-active` while `.segmented` only styles `.active`, so they had no
  visual selected state for three phases -- unnoticed because a standing
  explanation banner had been doing that job by accident, and it was removed in
  favour of per-tab `title` tooltips. Assert a control's state by its RENDERED
  effect, never by a class name: `drive-subqueue.js` reads the group header's
  COMPUTED `cursor`, and the aggregate-row check measures rendered `font-size`.
- **The DEV OVERLAY is a presentation layer, and its admin check is cosmetic
  (O-11).** `#dev-overlay` is an admin-only diagnostics panel — captured client
  errors, `google.script.run` timings/failures, app state, and a registry of
  admin-gated server diagnostics. Toggle: **Ctrl/Cmd+Alt+D** (Chrome reserves
  Ctrl+Shift+D) or the `#/dev` hash; persisted in `cdr.dev.overlay`.
  **The security rule that must not erode:** a localStorage flag is not
  authentication — anyone can set one — so the `role === 'admin'` check only
  keeps the panel out of a manager's way. Every diagnostic it invokes keeps its
  own `assertAdmin_()`, and the panel renders only what the server already sent
  THIS viewer. Never move an authorization decision into it, and never add a
  `DEV_DIAGNOSTICS_` entry pointing at a callable that is not admin-gated
  server-side. Entries carry `writes: true` when the diagnostic has a side
  effect (`runLiveSmoke` / `runNeonCoverageCheck` both email admins and stamp
  outcome properties) — those confirm before running.
  **App state is identifiers and flags ONLY, never a payload:** the Overview
  blob alone is ~27 KB, and re-rendering data the viewer is already looking at
  costs memory and screenshare exposure for nothing.
  **Why it exists:** two production bugs survived because the client records
  nothing — the dept selector threw `ReferenceError: prLastRoster is not
  defined` on every admin click, and CSS after `</st` + `yle>` rendered as
  visible text. Before this the client had ZERO `window.onerror` handlers and
  one `console.error` in ~20K lines.
  **The RPC probe is the risky part.** `google.script.run` is a getter that
  returns a FRESH, STATEFUL runner per access (it holds the handlers set on
  it), so the probe must re-invoke the original accessor every time — capturing
  one runner at install leaks chain A's handlers into chain B, which shipped in
  the first draft and was caught by `drive-devoverlay.js`. Comparing two reads
  for identity does NOT detect it (a new Proxy is minted either way); the check
  has to be behavioural. The whole install is try/caught and any doubt leaves
  `google.script.run` untouched — instrumentation is worth zero failed RPCs.
- **The keep-last-good (SWR) store is MULTI-SLOT, and that is the point.**
  `reportLastGoodWrite_` / `reportLastGoodRead_` (script.html) keep up to
  `REPORT_LASTGOOD_SLOTS_` (=4) signature-keyed entries per report, most-recent
  first. It was ONE slot, which made every A/B toggle a full server round trip:
  flipping the My Department sub-queue scope back and forth -- or two date
  ranges -- overwrote the other side's entry every time, so the return trip
  always missed. Correctness was never at risk (a signature mismatch is a MISS,
  never a wrong payload); it was purely slow, which is the kind of thing no
  assertion watches. Bounded on purpose: a big-roster summary payload is tens
  of KB against a ~5 MB localStorage budget shared with every other `cdr.*`
  key, so eviction is least-recently-WRITTEN and a quota error falls back to
  keeping only the newest entry. It also adopts the pre-multi-slot
  `{sig, at, data}` shape as a single entry rather than discarding a usable
  payload written by an older session. `drive-subqueue.js` asserts the store
  holds both scopes with DISTINCT signatures.
- **Per-report client prefs in localStorage.** Each report persists its
  own form state under `cdr.ir.prefs.v1:<email>` (via `irPrefsKey_()`, L3)
  and `cdr.ins.prefs.v2:<email>` (via `insPrefsKey_()`). **BOTH keys are
  PER-USER** (the `reportLastGoodKey_` pattern) -- their blobs store the
  agent selection, which must not restore for a different viewer on a shared
  machine; pre-per-user blobs under the bare `cdr.ins.prefs.v2` AND the bare
  `cdr.ir.prefs.v1` (IR was per-user'd later, L3) are orphans. The
  retired Performance / Compare Ranges reports' `cdr.pr.prefs.v1` /
  `cdr.cr.prefs.v1` are orphans too. **All six documented orphan keys are now
  deleted on load by `sweepOrphanPrefs_()`** (script.html, #5 Round-16; called
  first in `init()`, read-before-remove so a clean store costs no writes) --
  add a newly-orphaned exact key THERE, and never list a key that is still
  read as a migration fallback (the superseded `cdr.ov.cardperiod` /
  `cdr.ov.tableperiod.v1` stay un-swept for exactly that reason).
  Bump the trailing version when the prefs schema
  changes; older saved blobs are silently dropped if JSON parsing
  fails. The chrome layer also writes `dash-mode` (light/dark toggle),
  `dash-theme.v1` (warm / cool / clinical paper theme), and
  `cdr.charts.tooltips` (R11-G global chart hover-card on/off, Settings
  → "Show chart hover cards"), and `cdr.headlines` (R11-M report summary-banner
  on/off, Settings → "Show report summary banners" — `off` adds
  `body.headlines-off`, whose CSS hides every `.report-headline`; the
  `report-headlines` UI flag is the admin-global equivalent), plus the
  R12 view prefs: `cdr.ov.axiszoom` (Overview chart Full⇄Fit; default
  `fit`, R12-8b), `cdr.ins.abpanel` (the admin A/B VIEWS card's
  open/collapsed state; default collapsed, R12-11), `cdr.ov.window`
  (R12-19: the ONE Overview window driving cards + agent table --
  superseded `cdr.ov.cardperiod`/`cdr.ov.tableperiod.v1`, migrated
  table-pref-first), `cdr.dept.rowdensity` (R12-16 compact rows), and
  `cdr.dev.overlay` (O-11 dev overlay open/closed; ADMIN-ONLY and read only
  after the role check — it is a display preference, never an entitlement,
  and a manager setting it by hand gets nothing) — the theme
  picker re-reads these on every render so no cache bump is needed when
  palette tokens change. Default for first-time visitors
  (no `dash-theme.v1` value) is `cool` since the Phase A redesign
  rollout (commit 99e7253); explicit saved values, including `'warm'`,
  are preserved untouched. The `:root` tokens in `styles.html` remain
  the warm palette as the fallback for returning explicit-warm users
  (whose body carries no `data-theme` attribute). The Overview also
  stale-while-revalidate-caches its last successful payload under
  `cdr.ov.cache.v1:<email>:<role>` (Phase 5 / decision C6) — keyed per
  VIEWER so a cached blob never paints for a different user on a shared
  machine, and only the already-personalized payload the client received
  is stored (the server strips admin-only fields per-viewer first, INV-39).
  `ovLoad_` paints it instantly then revalidates; best-effort (any
  storage/parse error falls back to the normal fetch, and the live fetch
  always runs). Bump the `v1` if the Overview payload shape changes
  meaningfully.
- **CSS design-token conventions (post-redesign Phase A).** The
  dashboard's design system is centralized in `styles.html :root`;
  three conventions established by commit 99e7253 are worth respecting:
  (1) **`--bad` is for hard errors; `--warn` is for warnings.**
  `--bad` / `--bad-soft` are the deeper red for irrecoverable failure
  states (validation errors, fetch failures, access-denied UI). Only
  `.status-error` currently uses them. `--warn` / `--warn-soft` stay
  the default for negative-valence-but-not-fatal cases (low answer
  rate threshold, abandoned % warning, missed-delta orange,
  regression deltas). Reach for `--bad` deliberately when adding new
  error-state UI; don't blanket-replace existing `--warn` usage.
  (2) **`--r: 2px` is the canonical border-radius token.** New UI
  should use `var(--r)` for squared-off corners. Exceptions are
  intentional: `999px` pills/badges, `50%` avatars/dots, skeleton
  blocks (`.skeleton-line` 4px / `.skeleton-tile` 8px), and
  print-mode `border-radius: 0 !important` overrides. Five
  pre-Phase-A 6px / 8px callsites (alerts modal tables, QCD
  modal tables + view toggle, toast) were swept to `var(--r)`
  in the redesign cleanup commit (53d0560); bulk `2px`
  hardcodes (56 callsites) are visually identical to the token
  and intentionally left untouched. Email markup in `Alerts.gs`
  + `Digest.gs` keeps hardcoded radii because mail clients
  don't honor CSS custom properties.
  (3) **Uppercase mono kickers/eyebrows/labels use
  `letter-spacing: 0.18em`.** Mono numerics (blocks with
  `font-variant-numeric: tabular-nums`) use `letter-spacing: 0`.
  Swept across 47 selectors in commit 99e7253; new mono+uppercase
  selectors should match.
  *INV-42 follow-on:* `--bad` / `--bad-soft` are CSS-only — not yet
  mirrored into the JS `THEME` object or `refreshChartTheme()` in
  `script.html`. If a future phase surfaces error states in chart
  colors (Pipeline Health banner, etc.), extend `THEME` with
  `.bad` / `.badSoft` and resolve them via `colorToCanvasRgb_('--bad')`
  or chartjs-plugin-datalabels will silently render empty fills
  on the OKLCH path.
- **`ds-*` shared component layer (Phase 1 redesign — additive).** A
  canonical, token-driven component set lives at the END of
  `styles.html` (`.ds-kicker`, `.ds-section`, `.ds-chip`/`.ds-delta`,
  `.ds-kpi`, `.ds-card`/`.ds-card--rail`, `.ds-table`/`.ds-bar`,
  `.ds-banner`, `.ds-toolbar`/`.ds-seg`, `.ds-modal`) plus
  `.is-good`/`.is-warn`/`.is-bad` status helpers and additive tokens
  (`--r-sm`/`--r-lg`/`--r-pill`, `--shadow-1/2/modal`, `--ease`/`--dur-*`).
  It lands ALONGSIDE the legacy per-report dialects (`ir-`/`pr-`/`al-`/
  `ins-`/`cl-`/`of-`); reports migrate onto it one at a time. **Hard
  rules from the plan's conflict register (`docs/design-update-plan.md`):**
  (1) **`--r` STAYS 2px** — `ds-*` rounded corners use `--r-lg`/`--r-sm`/
  `--r-pill`, NEVER `var(--r)` (which is still the canonical 2px squared
  token); (2) status color is driven by the existing BINARY
  `benchValueCls_` (92% / 5%), NOT the design's invented 85%/8% bands;
  (3) dark mode is inherited via tokens — keep `body[data-mode="dark"]`,
  do NOT add the design's `[data-theme="dark"]` selector. Migrated so
  far: (a) the rollup KPI tile is the shared `dsKpiTile_` → `.ds-kpi`
  (Insights rollup; also the retired Performance Report's — first
  cross-report `ds-*` component, the consolidation thesis; old
  `prKpiTile_` retired); (b) the
  **Individual Report** KPI tile (`irKpiTile`) → `.ds-kpi` via the
  `.ds-kpi--ir` density modifier + the extension sub-elements
  `.ds-kpi__value-row`/`__share`/`__compare`/`__team`/`__prior`/`__spark--inline`
  (the inline share tag + "Team X" average marker + vs-prior row the base
  tile lacked); (c) the **per-agent cards** in Insights (`insBuildCard_`)
  AND (until its retirement) Compare Ranges → `.ds-card--rail`, the classification
  stripe driven by an inline `--status` (improved=accent / regressed=warn /
  mixed=muted, floater=warn); (d) in Insights, the queue-health per-queue
  table (`.ds-table` inside a `.ds-card`). The Insights length-mismatch
  caveat is now an INLINE `.ins-length-flag` next to the compare line (warn
  glyph + hover tooltip, `insLengthFlagHtml_`), NOT a standalone banner;
  (Compare Ranges' `.ds-banner is-warn` died with it). The now-dead `.ir-kpi-*`
  tile / `.ins-card-*` / `.cr-card-*` dialect CSS was swept (kept
  `.ir-kpi-grid` container + `.ir-spark-svg`). The shared `reportHeadline_`
  is intentionally NOT migrated (every report uses it). Report consolidation
  (Part 3) and the nav restructure (Part 6) are parked product decisions,
  not built.
- **Pass-2 design additions (all client-only, additive, reduced-motion
  aware).** Five small `ds-*`/helper pieces from the Pass-2 review
  (`docs/design-update-pass2-review.md`) -- no server compute / cache /
  metric change: (1) **B1 change-flash** -- `dsFlashChanged_(root, scopeId)`
  + `DS_PREV_VALUES_` snapshot `[data-flash-key]` node text per scope and add
  a one-shot `.ds-flash` ONLY on a real change (`hasOwnProperty` guard -> never
  on first paint); wired at the end of `ovRender_` (scope `overview`, so the
  SWR cache->live swap pulses only what moved) and the My-Department
  `render()` (scope `dept:<dept>`, keyed on the answered/missed bar cell). (2)
  **A1 Insights triage** -- whenever more than one card is shown,
  `insRenderAgentCards_` stable-partitions a COPY of `sortedMain` (never
  `insLastData.agentData`, so the Cards<->Chart toggle is unaffected) by
  direction-of-change into "Needs attention" (regressed) / "Mixed" /
  "Improving" tier headers (`insTriageHeader_`, full-width grid items, tones
  warn/muted/good) -- a header renders before each NON-EMPTY tier + an A2 rail
  legend (`insTriageLegend_`); the existing quiet `<details>` stays the bottom
  tier. (Phase 15 made this ALWAYS-ON; it previously rendered the grouping
  only when at least one agent was regressed, so a healthy cohort showed a
  flat ungrouped grid.) (3) **Loaders** -- `dsRingsHtml_` (`.ds-loader--rings`) in
  Caller Lookup's `cl-loading` state; the honest single `.ds-loader--staged`
  bar (one label, no faked stages) on the Overview boot pane. (4) **Overview
  retry** -- a "Retry now" button on the `ovSetRefreshWarn_` banner re-runs
  `ovLoad_(true)`. (5) **Card-entrance motion** -- `.ds-card--rail` fade+rise
  (`ds-card-in`) + status-rail grow-in (`ds-rail-grow`). Deferred from Pass-2:
  count-up, segment-slide, skeleton crossfade, C2 chart-slot spark, D2
  (permission tone). D1b (reports keep-last-good) SHIPPED since -- and
  gained an SWR layer (see the perceived-speed bullet below).
- **Report SWR (stale-while-revalidate) rides the D1b keep-last-good
  store.** `reportLastGoodWrite_/Read_` persist the LAST successful payload
  per (user, report) in localStorage, signature-matched via `reportSig_`
  (agents sorted). Two consumers: (1) `reportFailFallback_` -- on a failed
  fetch, repaint last-good + a warn "couldn't refresh" note (D1b); (2)
  `reportSwrPaint_` -- on a NEW request whose signature matches the stored
  one, paint it IMMEDIATELY with a `status-loading` "Showing your previous
  result for this exact selection — refreshing now…" note, while the live
  fetch always continues behind it. THE INDICATOR CONTRACT: every wired
  repaint path clears its results-status line (IR's renderer clears
  their own; Inbound + Insights use a repaint wrapper that clears
  `*-results-status`), so the note can never outlive the response it
  announced -- live success wipes it, failure swaps it for the D1b warn.
  Wired on: IR (main Generate; the edit-popover path keeps its own
  "Refreshing report…" status), Insights (which also gained the D1b store
  itself here), Inbound, and the My Department table (`refresh()` --
  its SWR paint passes `{swr:true}` to `onData` to skip the missed-section
  fetch so that section isn't fetched twice; the live pass triggers it
  once; a live-fetch FAILURE after an SWR paint keeps the painted table
  under a "couldn't refresh" error instead of wiping it to empty --
  `onError(err, hadSwrPaint)`). `reportSwrPaint_` calls its repaint
  function as `repaintFn(data, {swr:true})` so renderers can skip
  side-fetches on the pre-paint: Insights + Inbound skip their
  `loadAbandonHeatmap_` call (the live repaint fetches the heatmap once).
  Signature matching means a changed dept/range/selection never
  paints another request's stale shape -- those take the normal skeleton
  path. The Overview has its own separate SWR (`cdr.ov.cache.v1` +
  `ovSetCachedIndicator_`). One entry per report per user (last signature
  only) keeps localStorage bounded. New report run functions should wire
  all three pieces (write + SWR + fail-fallback) together.

## Overview page

- **Overview layout: stacked full-width sticky chart + 4-wide grid
  (Pass 3b P2).** The Overview page was restructured from a
  side-by-side grid+rail into a STACK: the 30-day trend chart is a
  **full-width sticky-top band** (`.ov-trend-col`, `position:sticky;
  top:8px; z-index:5`, floated above the grid via CSS `order:-1` so
  the `dashboard.html` markup order is unchanged; **collapsible since
  R11-B5** -- `#ov-trend-collapse-btn` folds the chart + controls to a slim
  strip so the dept cards take the screen, persisted per user in
  `cdr.ov.trendcollapsed`, chart re-measured on expand), and the dept-tile
  grid is **full-width below, 4-wide** (`.ov-dept-grid`
  `repeat(4,minmax(0,1fr))`, responsive 4→2→1). The retired side-rail
  was an intentional `#8` decision; it's safe to retire because the
  tile-hover→line-spotlight link works by **dept-name lookup**
  (`ovSpotlightDept_` matches `ds._deptName`), NOT DOM proximity, so
  the stack preserves it. Sub-queue **children render as dense chips**
  beneath the parent tile inside the `.ov-dept-group` cell
  (`ovBuildSubqChip_`: name + % answered + alert marker), each
  **expanding on click to the child's full tile** (`.ov-subq-tile-wrap`,
  hidden until expanded). The chips sit in the group cell, NOT inside the
  parent card — parent DQE metrics are independent, NOT a roll-up of
  children, so nesting them in would falsely imply aggregation. Chips
  carry `data-dept` so hovering one spotlights the child's chart line
  like a full tile; the expanded full tile keeps the admin route-to-dept
  click. (Superseded the earlier P1-hybrid "indented full child tiles".)
  The pinned band uses a moderate 340px height
  (`.ov-trend-col .ir-chart-wrap`) and un-sticks on short viewports
  (`@media (max-height:640px)`); the condense-on-scroll polish was
  intentionally skipped.
- **Overview trend chart conventions (Phase B).** Multi-dept overlay
  on the Overview page (`ov-trend-chart`): parent depts get solid
  2.2px lines with hue assigned from `IR_CHART_COLORS` in payload
  order; sub-queue children get dashed 1.4px lines (`borderDash:
  [4, 3]`) inheriting their parent's hue via the `colorByDept` map
  built up front in `ovRenderChart_` (so the parent → child color
  inheritance works even if children precede parents in the
  `depts` array). **The chart shows sub-queues BY DEFAULT now
  (`ovShowSubQueues_` defaults `true`) so they behave like other dept
  queues while staying visually linked (dashed + parent hue); the
  `sub-queues` checkbox (`#ov-subq-toggle`, `checked` by default) lets
  the user declutter to top-level depts only, re-rendering from
  `ovLastData`. Grid children are dense expand-to-tile chips (see the
  Overview layout bullet above).** A faint dashed 92% baseline (color
  `THEME.muted`) is drawn at `order: 99` so dept lines stay on
  top; the tooltip is filtered to hide the baseline from per-line
  hover. Fills are intentionally suppressed on this overlaid
  chart -- the soft-area gradient via `irGradientFill_` is
  reserved for single-series IR / PR trend tabs where it reads
  cleanly without 10+ overlapping fills competing. **The trend axis
  skips weekends AND weekday company holidays** -- `trendIsoLabels`
  (built server-side in `CompanyOverview.gs`, plus the shared
  `ovWeekdayIsoLabels_` for the 90-day / YTD chart series) drops Sat/Sun
  AND any `COMPANY_HOLIDAYS` weekday (S5, R11-L via `isCompanyHoliday_`)
  because the weekday-only work window makes them always-no-data, which
  otherwise rendered a sawtooth dip in every chart consuming the axis
  (per-dept card sparklines/arrows, the company sparkline, this chart).
  The Neon/sheet FETCH range stays the full calendar window so no
  weekday row is lost. Unset `COMPANY_HOLIDAYS` = no holidays dropped =
  pre-R11-L behavior (no cache bump, the S5 precedent). **Overview
  dept-grid tiles show a GOAL-GAP MINI LINE CHART (Round-16, replacing
  the R11-L trend arrow)** -- `irSparklineGoal_(vals, color, {goal, band})`
  draws the 30-day % answered series on the same honest 70-100% grown
  band, a dashed line at `answerTarget_('global')`, and fills the area
  BETWEEN the line and the goal (good-tinted above, warn below), so the
  amount of warn fill IS the amount of missed goal. The svg stretches
  full-width (`preserveAspectRatio="none"` + `vector-effect:
  non-scaling-stroke` on every stroke -- the default aspect-preserve
  letterboxed a 70x22 viewBox to ~89px centered; the end dot is a
  zero-length round-cap stroke so the stretch can't lozenge it). Colors
  ride THEME (INV-42). `irTrendArrow_` (the R11-L least-squares slope
  arrow it replaced) is kept in script-6-ir but currently uncalled.
  Sparklines STAY on the roomier
  surfaces (hero tile, company aggregate, expanded sub-queue card) but
  are now HONEST-SCALED there too -- `irSparkline_(vals, color, {band:[70,100]})`
  uses the same grown fixed band + gap-connects nulls (a no-data day no
  longer plots a 0% crash); omitting `opts` keeps the legacy auto-scale
  for count/duration sparks (IR/Insights KPI tiles). **Interactivity (shared `chartSpotlight*` helpers in
  `script.html`):** hovering a legend item dims the others
  (transient preview); clicking one PINS/isolates it (persistent
  dim of the rest -- click again or another to release/switch);
  `skipLabel` keeps the 92% baseline out of the dimming. Hovering a
  dept TILE spotlights that dept's line (`ovSpotlightDept_`, no-ops
  while a pin is active); clicking a POINT deep-links into that
  dept + date's My Department view (`ovHandlePointClick_` ->
  `ovRouteToDept_(dept, iso)`; admins, or a manager clicking their
  own dept's line). An axis-zoom toggle button (`ov-axis-zoom-btn`)
  flips the y-axis between Full (0-100%) and Fit (auto-scale to the
  data range) — **Fit is the DEFAULT since R12-8b** (owner: lines
  cluster at 85-95%, so Full rendered ~80% dead plot); the choice
  persists per user (`cdr.ov.axiszoom`). The same `chartSpotlight*`
  legend spotlight is reused by the QCD multi-queue chart.
  **R11-G auto-zoom-fit on solo (shared, all spotlight charts):**
  `chartSpotlightFitAxis_` auto-fits the y-axis to just the PINNED
  (soloed) series whenever the pin set changes (called from
  `chartSpotlightApplyPins_`); un-solo restores the build-time axis
  stashed by `chartSpotlightStash_` (`_origYAxis`). It reads scalar or
  `{x,y}` data and caps a percent axis at 100. The manual Overview
  Full/Fit toggle was KEPT -- it still fits ALL lines and composes with
  the stash/restore (the stash captures whatever the toggle built).
  **R11-G tooltip behavior (shared `chartTooltipPinFilter_`, set as the
  Chart.js default tooltip `filter` + composed into the Overview-baseline
  / QCD-threshold per-chart filters):** (5a) when a chart has soloed
  series, the hover card shows ONLY those; (5b) a GLOBAL "Show chart
  hover cards" Settings toggle (`cdr.charts.tooltips`, flag
  `CHART_TOOLTIPS_OFF_`) turns the card off across every chart by
  filtering out all items -- live on the next hover, no per-instance
  update, and the hovered point still highlights.

## Sub-queue relationship bar + grouped rows (My Department, Phase 1)

**Round-16 (owner): the relationship BAR is HIDDEN** — the "Combined
view…" banner, the child's upward pointer and the `subqSplitChip_`
"all queues" chip all sit behind `SUBQ_BAR_HIDDEN_` (script-5-dept; the
render code is intact — flip the constant to restore). The grouped table's
own subheaders + subtotals carry the relationship now, and the chip's B-1
mapping-mismatch signal surfaces only via `auditQueueSplitAttribution()`
(Operator State #41). The paragraphs below describe the bar as built, for
whenever it returns.

`#dept-subq-bar` sits above `.agents-table-wrap` and is rendered by
`subqRenderScopeBar_(state)` on every table paint. It renders whenever a
sub-queue relationship exists in either direction. That is the point of the
feature: before it, a parent-dept manager had no way to learn that a sub-queue
existed at all.

- The three-way scope switcher this bar once carried is **retired** — see
  "The sub-queue scope SWITCHER is retired; the group header is the control"
  above for what replaced it and why. The client no longer sends `subScope`;
  the server still accepts it and still owns the default (combined for a
  parent, own otherwise), so nothing here should hardcode that default in a
  second place.
- A CHILD dept renders the upward pointer only. One level, matching the server.
- `subqRowGroups_` returns grouped tbody HTML, or **null** when there is nothing
  to group -- a single-dept payload then takes the unchanged flat path, which is
  what keeps 11 of 14 depts byte-identical.
- Group order follows `meta.deptsShown` (parent first). Sorting stays GLOBAL and
  applies INSIDE each group, so a manager's chosen sort still means what it did.
- `subqSubtotalRowHtml_` renders a dept's own subtotal from `deptGroups`; the
  Source column is blanked (no aggregate). Styled QUIETER than the totals row on
  purpose: a subtotal is a reading aid, the grand total is the answer.

## Sub-queue picker groups (IR + Insights, Phase 2)

`irBuildAgentListHtml_(agents, activeAgents, activeFloaters, subQueueGroups)` --
the shared builder both report pickers use -- renders one collapsed
`<details class="ir-agent-details-subq" data-subq-dept="...">` per sub-queue,
after the Active / No-activity / Floaters groups.

- The group is **not** muted. Inactive and floater groups are de-emphasised
  because you rarely want them; a sub-queue is a department and a first-class
  choice.
- `subqPickerScope_(listEl)` reads the checked boxes and returns
  `{dept, mixed}`. `dept` non-null means the whole selection sits in one
  sub-queue group, so the run targets that department. `mixed:true` means the
  selection spans departments and the caller must REFUSE it -- the team
  average/rollup is per-dept (INV-25/27), so a mixed run would compare agents
  against the wrong team. Both `runInsReport` and the IR generate handler do
  this before building their request.
- The group carries an inline note saying the run will use that department's own
  team average, so the behavior is visible before the click rather than
  surprising afterwards.

## Combined-view CSV + the missed section's scope (Phase 1 follow-up / Phase 3)

`exportTableCsv_` gains a leading **Department** column only when
`meta.deptsShown.length > 1` and `state.deptGroups` exists — so a single-dept
export is byte-identical to before. Rows are emitted per department followed by
that department's own subtotal, then a grand total labelled `All shown`.

**No group-header pseudo-rows.** The on-screen table uses them because a human
reads top-to-bottom; a spreadsheet reader wants a Department COLUMN it can pivot
and filter on, and banner rows break both. The two surfaces differ on purpose.

The download filename gains a `_subs` / `_all` tag from `meta.subScope` so
exporting two scopes of the same dept and range doesn't silently overwrite. The
client no longer sends a scope, so in practice the tag now reflects the server's
default — kept because the server still varies it.

The **missed section** shows ONE dept at a time and never merges, because the
queue-only abandoned section already includes the parent's sub-queue queues via
`queuesForDept_` — merging a child's report in would double-count every queue
abandon and every abandoned-ring chart bucket. **Round-16 (owner): the
group-header "View X's missed calls" button and the `subqMissedScopeNote_`
scope banner are RETIRED** (the button's render is removed; the note hides
behind `SUBQ_BAR_HIDDEN_`) — a child's own missed calls are reached via the
header dept selector; the `subqMissedDeptOverride_` machinery stays inert
behind the removed button.

## Round-16 additions (owner-driven, 2026-08)

- **Agent-table volume tally**: agent rows render discrete answered/missed
  blocks at a cohort-shared adaptive unit (`ansTallyUnitFor_`, script-1-core;
  ≤36 blocks for the busiest row, unit disclosed in tooltips + a totals-row
  legend when >1); totals/subtotal rows keep the classic proportional
  `.ans-track` bar (an aggregate at agent scale would be hundreds of blocks).
  The R10-4 pass/fail treatment carries over (`.ans-bar--pass .tly.m` recedes
  translucent). `drive-subqueue.js` pins the agent-tally/subtotal-bar split.
- **Team strip**: non-hero tiles center both axes (the R12-23 treatment); the
  Answered + Queue-calls tiles merged into one "<total> (<ans> / <abd>)"
  split-value tile (`.dts-value--split`; abandoned mutes at zero), the same
  format the QCD side panel's Total Calls tile now uses — one dialect on both
  surfaces. The side panel's MTD view carries delta sub-lines
  (`.dept-qcd-sub`) vs the ENTIRE previous month, per-workday for volume.
- **Daily Call Queue Report**: the verdict band + email KPI tiles carry MTD
  sub-lines (`.qcd-mtd-sub`, full-prior-month baseline, per-workday volume);
  queue rows carry the `MTD Ø N/day` pace sub-line (`.qcd-q-sub`) — the EMAIL's
  queue rows too (`qMtdSubEmail` in QueueReportEmail.gs). Both surfaces put
  `/day` on the PRIOR value as well (R16c: a bare "Jun 100" read as a date).
  **R16c/R16d email shape** (owner rounds, pinned by
  `tests/unit/queue-report.test.js`): EVERY queue renders its own data row
  under its section banner — the banner-only collapse for single-queue
  sections is retired, because only queue rows carry the visual tally, so a
  dept without sub-queues had none. All four KPI cards center their content.
  The company card is titled "Daily Company Aban %" and tiers on its OWN
  ladder — value green ≤3% / amber 3–4% / red >4%, and the RED tier also
  tints the card (the Queues-in-viol treatment); the 5% queue-violation line
  still drives everything else, so the two thresholds are deliberately
  different numbers. The tally unit is **per SECTION**, not cohort-wide: one
  shared unit let a ~350-call/day dept set a block size that rendered a
  ~8-call/day queue as a sliver, so each section scales to its own busiest
  queue and discloses "block ≈ N calls" on its banner when N > 1 (the
  company-row "each block ≈" note went with it — one number would now lie).
  The trade-off is deliberate: blocks compare WITHIN a section, never
  across; cross-dept magnitude is the Total column's job. **R16e applies the
  same per-section unit to the WEB all-departments report** (`qcdSectionUnit`
  in script-11-qcd-boot, disclosed as `.qcd-deptrow-unit` on each dept
  banner; the single company-row `= N calls` legend went with the
  cohort-wide unit — one number would now be wrong for every section but
  one). **The email's block CEILING is 14, not the web's shared 36, and that
  is a LAYOUT constraint**: the email tally is a table of `width="5"` cells
  inside the ~150px Abandoned-% column, and past ~16 blocks the renderer
  shrinks every cell to fit, so blocks stop being uniform ROW TO ROW
  (measured: 20 blocks → 4.09px vs 5px on a 9-block row). The web tally's
  blocks are `flex: 0 0 auto` and wrap instead of shrinking, so it keeps the
  finer 36. Raising the email number without widening the column
  re-introduces the squeeze; `queue-report.test.js` pins the ceiling.
- **Insights Agents section**: the Cards view is HIDDEN for now (owner
  undecided; `#ins-cards-view-toggle` is `display:none` in dashboard.html and
  `insRestorePrefs_` restores only `'chart'`) and the Chart view defaults to
  the **Gap vs team** basis (M3 — since the M1 merge the agent table on the
  SAME page carries the Absolute information, so the section defaults to the
  one view the table can't show; a saved `'abs'` pref SELF-HEALS to gap).
  **R16g completes that logic: the Absolute OPTION is HIDDEN too** — the
  sub-toggle shows only Gap vs team / Trend (the abs button keeps its
  markup + wiring + renderer inert per the Round-16 removal convention; the
  admin A/B remote still reaches it). The metric selector dropped **Rung**
  (≈ answered + missed, so its gap/trend lines restated the other two; a
  saved `'rung'` pref self-heals to answered; the renderers still accept it
  if fed). All cards code is kept — single-agent reports still
  force cards, and the admin A/B remote's Cards button still reaches the
  hidden view. Un-hiding = remove the `display:none` + widen the pref restore.
- **Insights Daily breakdown**: two modes, decided by how many queues carry
  per-day rows (`insQhDailyMulti_`, ≥2 = MULTI). **MULTI (Round-16b/R16c, the
  parent-with-sub-queues case)**: every date renders ONE clickable "All
  queues" DAY row (dept-total `dailySeries` — the `queuesForDept_` rollup,
  CLASSIC bar per the house tally convention) with its per-queue TALLY rows
  (Queue-health payload order; sub-queues tagged `.ins-daily-q-sub`)
  COLLAPSED beneath (`insQhDayToggle_`; click or Enter/Space, the F13
  discipline). The Queue `<th>` is static markup revealed by
  `.ins-qh-daily--multi` on the `<details>`; rows carry `data-date` +
  `data-queue`, and a violation-date chip click force-opens its day before
  flashing the queue row (`insJumpToDailyRow_`) — no scoping needed, chip
  suppressed. **SINGLE (one-queue depts)**: a violation-date click SCOPES the
  table to that queue's own per-day rows (`qh.perQueue[i].daily`, additive
  payload field) before jumping — the dept-total row showed the PARENT's
  numbers for a sub-queue's date. A scope chip in the `<summary>`
  (`.ins-qh-scope-chip`, ✕ = back to dept total) names the active queue;
  scope resets on every fresh render. Both modes tally, unit computed from
  the DISPLAYED per-queue rows (re-scoping re-normalizes) with a
  `#ins-qh-daily-legend` line when unit>1. **Counts color-code to their
  blocks on the QCD daily surfaces** (`.qcd-daily-bar-cell` scope): abandoned
  `.miss-n` reads bad-red, a zero count carries `is-zero` and mutes
  (`qcdDailyBarCell_` emits the class; the agent table keeps its warn
  pairing). The agent-card `.ins-cbar-*` bars deliberately stay classic
  tracks — their job is position vs the team-average marker, which blocks
  can't carry.
- **Journey overlay**: internal-origin calls show a `.cj-internal-tag` and,
  when `relatedCallId` is present, a `.cj-related` context line whose button
  drills into the originating inbound call's path (delegated document
  listener).
- **`.ir-form-grid` is now DEFINED** (flex + wrap; it was referenced by five
  admin forms but never styled, so their fields stacked full-width). New
  admin form rows should use it rather than inventing another container.
- **Share of answered = TALLY ROWS, not a doughnut**: `insRenderShareChart_`
  (name kept, three call sites) builds `#ins-share-tally` — one grid row per
  agent (name | sage blocks at an `ansTallyUnitFor_` unit | count · share %),
  sorted most-answered first, the R11-E "Other agents" fold as a muted row
  (`.tly.oth`). No Chart.js instance anymore (`insShareChartInstance` is
  gone); still deferred behind the Team-detail `<details>`.
- **Company snapshot carries a pending-escalations line** (`#ov-agg-esc`,
  `ovAggEscRender_` in script-3): filled from the badge fetch's counts
  (`escBadgeLast_`, script-2 — `escApplyBadge_` repaints it on every badge
  refresh, so it follows mutations); zero renders a muted "none pending"
  statement, non-zero gets the overdue warn + an Open-worklist button.
- **My Department team strip frosts on refresh**: a same-dept refresh frosts
  `#dept-team-strip` alongside the agents table (M3 pattern); the SWR
  pre-paint's innerHTML replace destroys the overlay, so
  `renderDeptTeamStrip_` re-frosts when `.ds-frost-host` survives the wipe.
  The missed section's frost was already wired (R7 M-1) and is
  probe-verified working.
- **Goal-gap sparkline everywhere % answered trends render small**: the
  Overview grid tiles, the Company snapshot spark and the expanded
  sub-queue card all draw through `irSparklineGoal_` (dashed
  `answerTarget_('global')` line + good/warn fill between line and goal;
  script-6-ir). The retired hero-tile builder keeps the plain sparkline
  (uncalled). `irSparkline_`'s auto-scaled form stays for count/duration
  KPI sparks (IR/Insights tiles) — no goal exists for those.
- **Icon-only Refresh** on My Department (`#refresh-btn`): the ↻ glyph
  alone via the existing `.btn-icon` class; the label lives in
  `title`/`aria-label`. (R16c: the Insights region's own ↻ is GONE — one
  Refresh serves the whole page, see the R16c bullet.)
- **EmailKit (`EmailKit.gs`) is the outbound-email house style** — the
  Daily Call Queue Report's design language (600px card, kicker/title
  header, tinted KPI tiles, tally tables, bulletproof CTA, quiet footer)
  extracted as a shared layer. Consumers (Round-16, two passes): the
  My Department "Email me this report" export (`sendDepartmentSummaryEmail`
  in DeptSummaryEmail.gs — caller-recipient, rides getDepartmentSummary
  for auth + compute; menu item in the dept Export ▾), the Insights
  "Email report" (`sendInsightsReportEmail` — one consolidated form since
  R16c), the
  MANAGER DIGEST (all cadences + both formats — `sendDigestEmail_`'s
  shell, `digestSummaryHtml_`'s KPI rows, and the insights format now
  renders the SAME `insEmailReportRows_` as the Insights email; the old
  `renderInsightsEmail*`/`digestDeltaHtml_`/`digestHeroHtml_`/
  `digestStatTile_` renderers are retired), the low-answer-rate ALERT
  (`sendAlertEmail_`), the escalation notification (`escNotifyHtml_`),
  the Inbound report email, and the IR snapshot email's wrapper.
  QueueReportEmail.gs deliberately keeps its own pinned local copies.
  Plain-text admin/ops notices (failure emails, watchdogs, the
  pending-review ping) stay plain on purpose. Pinned by
  `tests/unit/dept-summary-email.test.js`, the insights email test's
  EmailKit assertions, and the digest-insights/digest-wow pins.
- **The Insights Simple/Detailed MODE is RETIRED for per-section
  progressive disclosure** (owner decision). Each heavy section is an
  always-present `<details class="ins-fold">` whose collapsed summary
  carries its headline (`insQhFoldSync_` fills Queue health's — e.g.
  "4.8% abandoned · 1,510 queue calls · 1 viol MTD"); Trends is the other
  fold, Team detail keeps its own `<details>`. Open state persists per
  user per section (`cdr.ins.folds.v1:<email>`); role seeds the defaults
  (admins open, managers collapsed) and an old saved density pref
  migrates once. Draw-on-open: the trend chart renders only while its
  fold is open (the C3 zero-height trap) and the admin heatmap fetches
  on Team-detail expand. The on-track card fold (ex-Simple treatment) is
  universal now. `ds-density-simple`, the toggle, the D3 Simple caption
  and the mode's special cases are all gone; an old share link's
  `view=detailed/simple` param maps onto the fold open-state. NOTE for
  the blank-canvas harness gate: newer Chromium answers
  offsetParent/gBCR for closed-`<details>` content via forced layout, so
  `drive-smoke`'s checker also skips `details:not([open])` canvases.
- **Insights header dates (DELETED — M4)**: the Phase-2 header From/To +
  shared Quick-select row (`#ins-hdr-controls`) was hidden in M2 (the dept
  controls row is the page's single date authority) and DELETED in M4 with
  its wiring (`insInitHeaderDates_`/`insSyncHeaderDates_`) and CSS. The
  canonical `#ins-from/#ins-to` inputs survive in the hidden fallback form
  (what deep links / saved views / the popover / `insSyncToDeptWindow_`
  write); `insApplyWindow_` (prior-window validation → picker regroup →
  prefs → runInsReport) survives as the shared re-run tail. The Edit
  popover is "Comparison & agents" (its date row hidden, not removed — the
  apply flow still round-trips those inputs). The prefs blob no longer
  saves/restores `preset/from/to` (saved VIEWS keep their own dates).
- **The INSIGHTS REGION (M1 merge + N1 always-inline,
  docs/insights-merge-plan.md)**: the whole ex-Insights-page lives in
  `<details id="dept-insights-region" open>` at the bottom of `#dept-page` —
  OPEN by default, rendering + GENERATING with the dept page:
  `deptInsightsEnsureLive_` runs on dept entry + every `refresh()`, gated on
  `data-page='dept'` (the Overview landing pays nothing) and on the region
  being open (a manual collapse is respected for the session; the `toggle`
  listener re-ensures on reopen). It wraps `insEnsurePage_` (first call arms
  the INV-45 auto-run), the M2/M3 sync, and `insRearmZeroCharts_` (recreates
  charts created while the page was hidden — the page-switch variant of the
  toggle re-arm).
  `setPage('insights')` still exists and MAPS to the dept page + open+scroll
  region (script-2), so every legacy entry works unchanged: deep links
  (`#/report/insights` + the three retired-report repoints + the Digest
  email links), the quick-start chips, and `handoffToInsights_`.
  `deptInsightsOpen_` runs the
  ensure SYNCHRONOUSLY because a programmatic `details.open=true` fires
  `toggle` async and the handoff/launcher callers write `ins-*` fields right
  after `setPage` returns — ensure-defaults-first is the page-era ordering
  contract. Every inner element id is unchanged incl. `#insights-page`
  (now a plain div; its scoped CSS + existence checks survive). Two sticky
  strips share the page: the dept controls pin at top, the Insights results
  header pins BELOW them at `var(--dept-sticky-h)` (z 59 vs 60; the
  `.is-stuck` shadow intentionally never fires on the offset strip). The
  Insights print path hides `#dept-page > :not(#dept-insights-region)` +
  chrome (the old rule hid `> .container`, which now CONTAINS the region).
  IR drill origin: the Insights call sites pass `{fromInsights:true}` to
  `irDrillToAgent_` — `data-page === 'insights'` no longer exists to read.
  The top-nav Insights TAB stayed retired (Round-16b); `initInsightsReport`
  null-guards it; the UI-harness drivers reach the region via `#my-dept-btn`
  ALONE — since N1 it is open and generating on arrival, so there is no
  switcher to click (`#lens-ins-btn` and the Insights-side "Agent table"
  button `#ins-open-mydept-btn` are both GONE; the Queue-health "See missed
  calls" scroll is the surviving in-page hand-off).
  **PERF-2: the first-init auto-run is deferred ONE TICK** (`setTimeout(0)`
  in `insEnsurePage_`) so the report RPC leaves in PARALLEL with the roster
  load instead of waiting behind it — that is the whole point of the odd-
  looking defer; do not "clean it up" into a straight call, which
  re-serializes two 2–5s Apps Script legs on every dept load. It stands
  down when a launcher/chip run is already armed (`insLauncherAutoRun_`), a
  pending agent selection is queued (`insPendingAgentSelection_`), or the
  dates are blank. **M2 (shipped): the dept controls row is the page's single date
  authority.** The region's own header From/To + Quick-select row
  (`#ins-hdr-controls`) is hidden (wiring inert until M4);
  `insSyncToDeptWindow_` converges an open region on `refresh()` and a stale
  closed region on its next toggle-open (compare-rendered-meta-vs-dept, no
  flag), SKIPPING while a programmatic run is armed so chip/share-link
  windows never race a dept-window run — priority: share link >
  chip/handoff > dept window > prefs > defaults. The collapsed summary
  carries a live headline after each render (`insRegionHeadSync_` →
  `#ins-region-head`: % answered · missed · abandoned % · window; the
  static sub line yields). Open-state is deliberately NOT persisted — since
  N1 open-and-generating IS the default, so persistence could only ever
  remember a COLLAPSE, and a manual collapse is meant to last the session
  only. The region's own Export menu is gone (R16c: one dept Export menu
  with an Insights group). `adoptSharedWindow_` is retired — `pageActiveWindow_` remains
  only to feed the R11-C2 dwell prefetch. The toggle-open path also
  RECREATES the charts from `insLastData` (destroy + create) so a report
  that rendered while the region was collapsed mid-generate isn't left with
  0×0 canvases. **M3 (shipped): scope polish** — the `#ins-dept-pill` LABEL
  (not a second selector; the header dept selector stays the authority)
  states the report's dept, warn-tinted when a sub-queue selection narrowed
  it; the dept leads the collapsed headline; `insSyncToDeptWindow_` also
  converges on a header dept SWITCH (`insLastHeaderDept_`, re-ensure roster
  + agent-free auto-run); both same-page hand-offs became in-page scrolls
  (`qsSpotlight_('dept-missed-section')` / scroll to the table,
  `handoffToMyDept_` kept as the not-rendered fallback); the Agents chart
  defaults to Gap vs team with a saved `'abs'` self-heal; the fixed A/B
  remote hides while the region is off-screen (IntersectionObserver →
  `.ins-ab-offscreen`). **M4 (shipped): the transition machinery is
  retired** — `handoffToInsights_`, the header-dates row + wiring, the
  ex-hand-off hover-prefetch, the dead router branches (`basePageRoute_`
  insights arm, the effRoute mapping), the `irDrillToAgent_` data-page belt
  and the prefs-blob dates are deleted. **N1 (shipped, post-deploy owner
  feedback): the LENS SWITCHER is REMOVED on both sides** — it read as a
  page toggle; with the region open-inline there is nothing to switch (the
  `.ds-lens-switch` CSS and the whole dwell-prefetch / shared-window-store
  family — `pageActiveWindow_`, `recordPageWindow_`, `armDwellPrefetch_`,
  `insDwellPrefetch_`, `prefetchDeptSummary_` — went with it; the real
  fetch fires up front now). `setPage('insights')` + the
  `/report/insights` route/share-state entries are PERMANENT compat
  surface for deep links + the Digest email links.
- **R16c (post-N1 owner notes)**: the Team-detail heatmap + share table sit
  SIDE BY SIDE in `.ins-detail-row` (flex-wrap; managers never get the
  admin-gated heatmap, so the share table takes the full row with zero JS;
  narrow viewports stack). **ONE Export menu + ONE Refresh** on the dept
  controls row: `#dept-export-menu` carries two labeled groups
  (`.ir-export-group-label` — "Agent table" / "Insights", the Insights
  group revealed at menu-open once `insLastData` exists) dispatching to the
  hoisted `insDownloadCsv_`/`insCopyImage_`/`insEmailReport_`/`insPrint_`;
  the region's own ↻/Export are gone, and the dept Refresh's click handler
  adds a SAME-window `runInsReport()` pass (deferred a tick, standing down
  when the convergence sync already fired — the in-flight check is the
  generate button's disabled state). The missed section's loader now covers
  `#dept-missed-detail` too (`deptMissedDetailFrost_` — the queue-only +
  agent-timeline block is a SIBLING the section frost never reached).
  The My Department email renders per-dept SECTIONS on combined payloads
  (heading band + worst-first agents + a `deptGroups` subtotal per dept, no
  Dept column); the Insights email is ONE consolidated form (see the email
  bullet). **R16e (owner round)**: five more. (1) The agent table's Total cell
  reads a bare **"Total"** — the roster/floater/crossover caption moved into
  its `title` (dotted-underline `.agents-total-label.has-note`) and the CSV
  total row still spells it out; the caption is NOT droppable (an unexplained
  subtotal-vs-total shortfall reads as a bug), so `drive-smoke.js` asserts the
  label is bare AND the tooltip survives. (2) The Insights **Views** menu is
  hidden for everyone (markup + wiring inert, the Round-16 removal convention)
  and **"Comparison & agents"** moved into the results title line
  (`.ins-edit-inline-btn`, same id, same popover wiring). (3) The heatmap
  **cell drill renders BELOW** the heatmap/share row in `#ins-heat-detail`,
  its two lenses side by side ≥900px: a host that sets `data-heat-detail`
  opts out of the shared renderer's in-panel `.ds-heatmap-detail` and writes
  to the named element instead (`heatDetailEl_`), and `renderAbandonHeatmap_`
  RESETS that external panel on every render since the innerHTML swap can no
  longer clear it. The Inbound report sets no attribute and is unchanged. The
  row also STRETCHES — the heatmap grid fills the share table's height via
  `grid-template-rows: auto` + `grid-auto-rows: minmax(26px, 1fr)`, so the
  day rows absorb the slack and the hour-label row doesn't. (4) Daily
  breakdown motion: sub-rows fade+settle through `ins-daily-row-in` on their
  CELLS (a `<tr>` can't animate a display flip) and the `<details>` body gets
  the shared `ins-fold-in`, both reduced-motion-gated; an at/over-5% abandoned
  rate reads bold + `--bad` — the weight has to be restated locally because
  the global `.qcd-rate-over` loses on specificity to `.ans-nums .ans-rate`.
  R16f: the COLLAPSE animates too — closing rows hold `.is-open` through a
  140ms `.is-closing` fade-out before `insQhDayToggle_`'s timer removes them
  (the timer lives on the day row so a rapid re-open cancels it), and closing
  the "Daily breakdown" `<details>` intercepts the summary click to play the
  mirrored `ins-fold-out` before flipping `open` off — a native details close
  is instant, so without the intercept only the open direction animated. Also
  R16f: a tally legend rendered as the last child of a `.ds-card` gets its
  own padding (`.ds-card > .ans-tally-legend`) — flush against the card edge
  the rounded corner + overflow clipped it half off.
  (5) Queue health gained cards: **Avg answer** + **Longest wait** promoted
  out of the muted secondary strip (now empty for the dept total; it still
  serves the per-queue expanded rows), **Transfer %** mirrored from the dept
  strip, and **Queue calls** adopting the strip's "total (answered /
  abandoned)" split + per-workday foot — since R16f as TWO lines
  (`.qh-calls-total` full-size, `.qh-calls-split` 13px beneath; one long
  inline value read disproportionate on a half-width card). Transfer % reads `state.csrTransfer`
  (the DEPT payload, CSR-only) and renders ONLY when both surfaces show the
  same window — a share link or saved view can put Insights on its own, and a
  transfer rate from another range inside this section would be a quiet lie.
  Six cards make the left column a 2-up grid, CENTER-aligned (label, value,
  foot) in a narrower column — scoped to `.ins-qh-left` so the IR / Inbound /
  Direct KPI rows sharing `.ds-kpi` stay left-aligned; the top line centers as
  a group (`justify-content:center`) and wraps its delta badge under the label
  rather than breaking "Abandoned %" mid-phrase. **R16d**: the Queue-health KPI tiles STACK in a left third beside
  the per-queue table (right two-thirds) in `.ins-qh-cols` — same flex-wrap
  discipline; ≤900px stacks the columns and returns the tiles to a
  horizontal grid in one media query (splitting the two left 3-across tiles
  inside a 250px column). ⚠ The wrapper class is `.ins-qh-cols`, NOT
  `.ins-qh-row` — that name is already the queue table's `<tr>` class
  (`insRenderQueueHealth_`'s row builder), and a flex rule on it wrecks the
  table rows.
- **Phase 3 motion** (all reduced-motion-safe): a 160ms fade on the page
  swap (pure CSS — animations restart when display flips), a 180ms
  slide/fade on fold expand (`ins-fold-in`), and elevation-on-stuck for
  the two sticky strips (IntersectionObserver toggles `.is-stuck`; the
  drop shadow only paints while pinned). The fold caret is a SQUARE
  inline-block box — a bare glyph box rotated 90° poked 2px past the
  page edge and tripped the overflow gate.
- **Round-16 removals** (all code kept inert behind flags/hidden markup):
  the Missed-report Bars/Radar toggle is hidden for everyone
  (`missedChartMode_` hardcodes bars); the My Department sub-queue
  relationship bar — the "Combined view…" banner, the child's upward
  pointer AND the `subqSplitChip_` "all queues" flag — is hidden
  (`SUBQ_BAR_HIDDEN_`; the chip's B-1 mapping-mismatch warnings now
  surface only via `auditQueueSplitAttribution()`, Op State #41); the
  group-heading "View X's missed calls" button and the missed-section
  "Per-agent timelines below…" scope banner are gone
  (`drive-subqueue.js` pins all of these hidden); and the My Department
  `#dept-insights-strip` Insights TEASER STRIP is retired outright
  (markup, `renderDeptInsightsStrip_`/`wireDeptInsightsStrip_`, `.dis-*`
  CSS) — the lens switcher is the route to Insights.
