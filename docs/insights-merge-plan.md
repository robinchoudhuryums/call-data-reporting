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

### M3 — Scope polish

- Dept pill on the region header for parent depts (primary dept default;
  drives the insights RPC's `department` param; `subqPickerScope_` still
  refuses cross-dept selections).
- Queue health "See missed calls →" becomes an in-page scroll to the missed
  section (no `handoffToMyDept_` round trip).
- Agents section defaults to **Gap vs team** (the tally table on the same
  page already carries the Absolute information).
- A/B panel visibility: currently shows whenever the region is open (it's
  inside the region, `position: fixed`); scope it to "region open AND in
  view" or fold it into the region header.

### M4 — Retirement + cleanup

- Delete: `handoffToInsights_` / `launcherOpenInsights_`'s setPage detour
  (they become open-region helpers), `adoptSharedWindow_`, the dwell-prefetch
  'insights' page arm, the lens switcher (both sides), the dead
  `basePageRoute_` insights branch, the `updateTabActiveState_` effRoute
  mapping, the `data-page === 'insights'` belt in `irDrillToAgent_`.
- Tour + Help rewording; docs + scenarios sweep (S14/S18/S19/S32/S37);
  CLAUDE.md multi-page bullet → three pages (Overview / My Department /
  Escalations).
- Harness drivers walk the region natively (no lens-button dependency).

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
