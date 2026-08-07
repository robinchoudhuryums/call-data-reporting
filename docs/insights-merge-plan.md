# Insights → My Department merge plan (M1–M4)

Owner-approved (2026-08-07): fold the entire Insights page into My Department
so all department information lives on one scannable page, using the
progressive-disclosure fold layer Insights already has. This is the end state
of the consolidation trajectory (PR→Insights, CR→Insights, QCD→Insights,
Missed modal→inline dept section, teaser strip→lens switcher); the Missed
report is the precedent that a separate surface becoming an inline dept
section works.

**Zero server changes.** `getInsightsReport`, its caches (`insights:` prefix,
INV-30), the emails, and the saved-view/share-link payload shapes are all
untouched across every phase. This is a client-side restructure.

## The two load-bearing design rules

1. **Laziness is non-negotiable.** The Insights region's RPC fires on FIRST
   fold open, never on dept-page load — otherwise every manager pays a second
   2–5s Apps Script round trip on every visit. Cold dept-page load stays
   byte-identical to the pre-merge page.
2. **"One report run is one department" survives.** Parent depts (CSR /
   Sales / Power) see a COMBINED agent table but Insights runs one dept;
   adjacent sections on one page must state their scope rather than imply it
   (the M3 dept pill).

## Phases

### M1 — Move + route  ✅ (this commit)

- The Insights page `<section>` content moves inside `#dept-page` as
  `<details id="dept-insights-region">`, full-width below the dept layout
  (agent table + missed section + QCD aside). Every inner element id is
  unchanged — including `#insights-page` itself, now a plain div — so the
  `ins-*` wiring, the `#insights-page`-scoped CSS, and the existence checks
  (`launcherOpenInsights_` / `handoffToInsights_`) all survive.
- `setPage('insights')` maps to the dept page + `deptInsightsOpen_({scroll})`
  (script-2), so every legacy entry — deep links (`#/report/insights` and the
  three retired-report repoints), the Digest email links, the quick-start
  chips, the lens switcher — lands on the open region. `deptInsightsOpen_`
  runs `insEnsurePage_` SYNCHRONOUSLY (a programmatic `details.open = true`
  fires its `toggle` async, and the handoff/launcher callers write `ins-*`
  fields right after `setPage` returns — the ensure's defaults/prefs restore
  must precede those writes, the ordering the page era guaranteed).
- A user-click open of the region runs the same ensure via the `toggle`
  listener (idempotent). Region defaults CLOSED, no persistence yet (an M2
  decision — restoring open-state would re-fire the RPC on every dept visit).
- The IR drill origin (`Back to Insights`) can no longer read
  `data-page === 'insights'`; the Insights call sites pass
  `{fromInsights: true}` to `irDrillToAgent_` explicitly.
- Sticky strips stack: the dept controls keep the viewport top, the Insights
  results header pins below them at `var(--dept-sticky-h)`.
- Print path retargeted: `body.ins-printing` hides the chrome + every
  `#dept-page` sibling of the region (the old rule hid `> .container`, which
  now CONTAINS the region).
- `body[data-page="insights"]` CSS toggles retired; the harness drivers
  already route via `#my-dept-btn` → `#lens-ins-btn` and keep working
  unchanged.

### M2 — Controls reconciliation  ✅

- **One date authority — the dept controls row.** The region's own header
  From/To + Quick-select row (`#ins-hdr-controls`) is hidden (markup +
  wiring kept inert for M4); the results-date pill still states the rendered
  window. `insSyncToDeptWindow_` (script-8) converges an OPEN region onto
  the dept window: called from `refresh()` (a rendered report re-runs via
  `insApplyWindow_` when the window moved) and from the region's toggle-open
  (a stale closed region re-runs on its next open — the "mark stale,
  re-fetch on open" contract, implemented as compare-rendered-meta-vs-dept
  rather than a flag). It SKIPS while a programmatic run is armed
  (`insLauncherAutoRun_`/`insAutoRunPending_`) — that run owns its window,
  so the quick-start chips' 30-day promise and share-link windows can't
  race a second dept-window run. Window priority ends up: share link >
  chip/handoff > dept window > prefs > defaults. First open seeds the ins
  dates from the dept inputs (overriding restored prefs dates).
- **Region headline** (`insRegionHeadSync_` + `#ins-region-head`): after
  each render the collapsed summary shows `% answered · missed rings ·
  abandoned % · from → to`; the static sub line yields. The explicit window
  makes post-change staleness visible on a closed region.
- **Open-state persistence: DECIDED — none.** The region always starts
  closed; restoring open=true would re-fire the report RPC on every dept
  visit for users who left it open, violating the laziness contract. Deep
  links, chips, and the lens switcher open it; one click otherwise.
- **Exports: DECIDED — per-region menus stay** (each report owns its
  export; the dept table's Export ▾ and the region's Export ▾ serve
  different payloads).
- **`adoptSharedWindow_` retired** (both call sites were already gone or
  replaced by the sync); `pageActiveWindow_`/`recordPageWindow_` survive
  only to feed the R11-C2 dwell prefetch — M4 slims further.
- **Closed-mid-generate chart re-arm**: the toggle-open path recreates the
  cards chart / trend chart / deferred detail charts from `insLastData`
  (destroy + create, the C3-safe path — `resize()` alone does not reliably
  recover a 0×0 create).

### M3 — Scope polish  ✅

- **Dept identity — a LABEL pill, not a second selector.** `#ins-dept-pill`
  (results title line) states which dept the report covers, filled from
  `meta.department` per render; a warn-tinted `--scoped` variant marks a
  sub-queue-narrowed run (`meta.department ≠ getRequestedDept()`). The
  HEADER dept selector stays the only way to change dept (one-authority,
  the M2 model — parent managers can already pick children there via
  `canPickDept_`). The dept also LEADS the collapsed region headline.
  **Dept-switch convergence** (the M2 gap): `insSyncToDeptWindow_` now
  tracks `insLastHeaderDept_` (the header dept at run time — deliberately
  not `meta.department`, which a sub-queue selection legitimately narrows)
  and on a switch re-ensures the roster + arms the agent-free
  first-open-style run behind the loading pane, so an open region follows
  the header selector. `subqPickerScope_` still refuses cross-dept
  selections.
- **In-page scrolls** replaced BOTH same-page hand-offs (each previously
  cost a `setPage` + `refresh()` round trip re-fetching an
  already-rendered summary): Queue health's "See missed calls →" spotlights
  `#dept-missed-section` (`qsSpotlight_`), and the lens switcher's "Agent
  table" side scrolls to the table. `handoffToMyDept_` survives as the
  fallback when the target isn't rendered.
- **Agents section defaults to Gap vs team** (`insCardsChartMode = 'gap'`);
  a saved `'abs'` pref SELF-HEALS to gap (most blobs carry `'abs'` from
  mere usage under the old default, not intent — the non-admin `'att'`
  self-heal precedent). Abs/Trend stay one click away.
- **A/B panel scoped to "region on screen"**: an IntersectionObserver on
  the region toggles `.ins-ab-offscreen` (CSS `display:none !important`
  beats the admin reveal loop's inline `display:''`), so the fixed remote
  no longer floats over the agent table / missed section while the open
  region is scrolled out of view.

### M4 — Retirement + cleanup  ✅

- **Lens switcher: KEPT as a jump affordance (owner-endorsed lean)** — the
  merged page is long, so "Insights" opens + scrolls to the region
  (`deptInsightsOpen_` directly; no date carry, no forced re-generate — the
  old `handoffToInsights_` armed a run per click that the convergence sync
  + first-open auto-run make unnecessary) and "Agent table" scrolls back up
  (M3). Titles reworded to say "jump".
- Deleted: `handoffToInsights_` (no callers left); the `#ins-hdr-controls`
  markup + `insInitHeaderDates_`/`insSyncHeaderDates_`/`insHeaderDatesWired_`
  + their CSS (the row had been hidden since M2; `insApplyWindow_` survives
  as the shared re-run tail); the #5-Option-A hover-prefetch on the two
  ex-hand-off buttons (they scroll now — nothing to warm); the
  `basePageRoute_` insights branch; the `updateTabActiveState_` effRoute
  mapping; the `data-page === 'insights'` belt in `irDrillToAgent_`
  (origin travels solely as `opts.fromInsights`); the dwell-prefetch
  'insights' arm + the `pageActiveWindow_.insights` slot (the store is
  dept-only, feeding the kept region-open dwell warm); the prefs blob's
  `preset/from/to` fields (neither saved nor restored — the dept controls
  seed the window; saved VIEWS keep their own dates deliberately).
- `setPage('insights')` and the `ROUTES_`/`SHARE_STATE_` `/report/insights`
  entries are PERMANENT compat surface, not leftovers — deep links and the
  Digest email links ride them.
- Comment/doc sweep: dashboard.html (lens titles, region comment, popover
  title), script-2/4/5 comments, conventions, scenarios, this plan.
- Harness drivers unchanged — they click `#my-dept-btn` → `#lens-ins-btn`,
  which is exactly the kept jump affordance.

## Watchpoints (all phases)

- The C3 draw-on-open trap: charts must never instantiate inside a closed
  `<details>`; the inner folds already re-arm on open, and `insResizeCharts_`
  re-measures on region open.
- `npm run ci:ui` must keep asserting the Insights surfaces at every phase —
  the drivers were kept on the lens-switcher path in M1 precisely so the gate
  never goes blind.
- Losing the "Insights in its own browser tab beside the table" workflow is
  accepted (post-merge that's scrolling); the Open-in-new-tab button still
  deep-links to the region.
