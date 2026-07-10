# Insights modal → dedicated page — approved plan

Owner-approved 2026-07-10. Client-only conversion (script.html /
dashboard.html / styles.html); InsightsReport.gs, the `insights:v18`
cache, and the consolidation-freeze test are untouched. Single PR,
one Department Dashboard deploy, reversible by revert.

Precedent: the Escalations modal→page conversion (#6) — a `.page`
section outside the main container, toggled by `body[data-page]`,
with `setPage()` owning the header kicker/title and lazy init on
first entry.

## Locked decisions (owner-approved)

1. **Navigation**: Insights is its own always-visible top-level header
   tab (it replaced the manager-only `#insights-solo-btn` proxy, #10).
   The admin-only Reports dropdown keeps Individual + the admin-vetted
   Inbound / Direct.
2. **Route**: `#/report/insights` stays the canonical route, re-typed
   to `kind:'page'`. The three legacy repoints (`/report/performance`,
   `/report/compare`, `/report/qcd`) re-type with it. Zero external
   breakage (digest emails, bookmarks).
3. **Re-entry keeps the rendered report**: first entry shows the setup
   form; after generating, navigating away and back preserves the
   results (a deliberate improvement — the modal's `openModal` reset to
   the form on every re-open).
4. **Layout**: `.ins-page-body` at the main container's 1440px
   (data-dense), not the Escalations worklist's 1100px.

## The one subtle bit — digest deep links

`Digest.gs` emails build `#/report/insights?from=…&agents=…` links.
The deep-link reader's **page-route branch currently drops `?query`
state** (fine for `/report/missed`, fatal here). Phase 2 must extend
that branch to run the `SHARE_STATE_['/report/insights']` provider
apply after `setPage('insights')`. Digest.gs itself needs no change.

## Phases (one PR; intermediate commits are NOT deployable)

- [x] **Phase 1 — markup move** (this commit): modal panel-body
  contents lifted into `<section id="insights-page" class="page
  page-insights"><div class="ins-page-body">…</div></section>` in
  place of the modal (both sit outside `.container`); modal shell
  (backdrop / panel / header / close / kicker / h2) deleted; the
  open-in-new-tab button relocated as the first child of
  `.ins-page-body` (same `.modal-open-tab-btn` class +
  `data-open-tab-route` — the wiring loop keys on those); top-level
  Insights tab added carrying the stable `#insights-report-btn` id
  (all JS entry points keep working); `#insights-solo-btn` removed
  (its script.html wiring is null-checked → no-ops until Phase 3
  cleanup); Reports dropdown loses the Insights item. Structural CSS:
  the `body[data-page="insights"]` display rule + `.ins-page-body`
  (1440px, `position:relative` anchoring the open-tab button).
  **Intermediate state: Insights is UNREACHABLE** — `initInsightsReport`
  early-returns (`$('insights-modal')` is null) so nothing is wired,
  and `setPage` doesn't know `'insights'` yet.
- [x] **Phase 2 — router/page plumbing** (script.html): `setPage`
  gains `'insights'` (kicker "Reports · Insights", title "Insights";
  first-entry init via the new `insEnsurePage_` = what `openModal`
  did: `insShowForm` + default dates + prefs restore +
  `insEnsureRoster`; re-entry only re-ensures the roster and never
  clobbers rendered results — decision 3); `ROUTES_` re-typed the 4
  routes to `kind:'page', page:'insights'` (buttonId/modalId fields
  dropped); `basePageRoute_` + the `setRoute_` call in `setPage` gain
  the insights case (so closing an IR drill modal restores the
  Insights tab highlight); **the deep-link page branch applies
  SHARE_STATE_ query state** (the digest-email keeper). Pulled forward
  from Phase 3: the tab click → `setPage('insights')` wiring (the
  deep-link trigger path clicks the tab, so the route re-types are
  dead without it). Intermediate state after Phase 2: the page opens
  and shows the form, and the LAUNCHER auto-run path may work
  end-to-end (it calls `runInsReport()` programmatically), but manual
  form controls (Generate, presets, popover, export) stay unwired
  until Phase 3 — `initInsightsReport` still early-returns on the
  absent modal right after wiring the tab.
- [x] **Phase 3 — `initInsightsReport` rework**: modal machinery
  deleted (openModal/closeModal, trapFocus_, drag/resize, scroll lock,
  Escape, backdrop, `#insights-close`); guard is now
  `if (!btn || !page) return;`; all form / popover / export wiring
  kept verbatim, with the three delegated listeners (card IR-drill
  click, hover-prefetch mouseover/mouseout) retargeted from the modal
  to `#insights-page`; the dead `insights-solo-btn` wiring blocks
  deleted (init reveal, proxy click, View-as toggle) — the top-level
  tab has no `data-admin-only` so View-as keeps it visible. After
  Phase 3 the page is functionally COMPLETE except: the IR drill
  degrades gracefully (no "Back to Insights" button — `irDrillToAgent_`
  still probes the absent modal, Phase 4) and printing still targets
  the modal selectors (Phase 6).
- [x] **Phase 4 — IR drill simplification**: `irDrillToAgent_` detects
  the Insights origin via `data-page === 'insights'` (both
  `$('insights-modal')` probes gone — script.html now has ZERO
  insights-modal references); the modal hide/re-show and the
  `irCameFromInsights_` scroll-lock juggling in IR's `closeModal` are
  deleted (the page sits behind the IR overlay all along); the flag
  survives solely for the "Back to Insights" button visibility swap.
  Focus deliberately stays put on drill-close (the old `btn.focus()`
  target lives in the admin-only Reports dropdown). Known cosmetic
  carry-over (pre-existing, unchanged): closing IR via the
  Back-to-Insights button doesn't refresh the tab highlight (only
  `.modal-close`/`[data-close]` clicks do) — same class as the
  documented Escape-close gap.
- [x] **Phase 5 — launcher**: `launcherOpenInsights_` calls
  `setPage('insights')` instead of clicking the button (guarded on
  `$('insights-page')`); auto-run flag, loading pane, and the CL1-2
  failure fallback unchanged. On a re-entry launch, `insEnsurePage_`'s
  roster call with the OLD dates fires first and the launcher's
  re-ensure with the new range supersedes it — the CL1-3
  `insRosterReqSeq_` token makes that race safe (same double-fetch the
  modal era had).
- [x] **Phase 6 — CSS finish**: the `body.ins-printing` print block
  retargeted from `#insights-modal` / `.modal-panel` to
  `#insights-page` / `.ins-page-body` (un-constrain width, hide the
  form / open-tab button / toolbars; quiet-details + page-break rules
  unchanged; the dead `.modal-backdrop` line dropped) — repo-wide
  `insights-modal` references are now ZERO; `insResizeCharts_()` (the
  `deptMissedResize_` double-rAF pattern) re-measures the trend /
  share / cards chart instances on every page entry, guarding the
  measure-while-hidden gotcha after a window resize on another page.
  Visual polish at 1440px is deliberately left to the Phase 8 manual
  smoke (fluid grids are expected to just stretch).
- [x] **Phase 7 — copy/docs sweep**: tour gained an Insights-tab step
  and the "Deeper reports" step now describes the admin dropdown
  (Individual + Inbound/Direct); Help "The four pages" topic + nav
  topic + an Insights-is-a-page lead-in; CLAUDE.md (multi-page
  architecture bullet, INV-37 re-written to the multi-page model,
  IR-drill paragraph in the consolidation bullet, router/deep-link
  bullet incl. the page-branch SHARE_STATE_ note, draggable-modals
  count, PR/CR "buttonId repoint" → "page repoint", INV-45 +
  S14/S32 "Insights modal" → "page"); docs/known-issues.md digest
  bridge wording. No cache-version strings touched (the
  cache-version-sync test stayed green).
- [x] **Phase 8 — verification (automated)**: div/section nesting
  balanced; repo-wide `insights-modal` refs = 0; extracted-JS
  `node --check` clean; 280/280 `node --test`; INV-16 guard clean.
  Shipped as ONE PR (all conversion commits).

## Post-deploy manual smoke (operator; needs the live web app)

1. **S37** — full Insights e2e from the new tab: agent-free Generate,
   Queue health, comparison modes, exports (incl. Print — the
   retargeted `ins-printing` block), edit popover.
2. **S14** — absorbed-PR views + a `#/report/performance` deep link
   (lands on the page).
3. **Digest deep link WITH query state** — from a digest email (or
   hand-build `#/report/insights?from=...&to=...&agents=a|b`):
   the page opens with the form primed to those exact values.
4. **Launcher chips** — "team lately" + "abandons" auto-run on the
   page; loading pane covers the run; a forced roster failure falls
   back to the form (no eternal pane).
5. **IR drill round-trip** — card → IR modal overlays the page →
   "Back to Insights" closes IR revealing the intact report; generic
   "« Back" restored on IR's next direct open.
6. **Open-in-new-tab** — the ↗ button top-right of the page carries
   form state; disabled (hidden) when DASHBOARD_URL unset.
7. **S23** — tab active states incl. the Insights tab; re-entry keeps
   the rendered report; charts still sized right after a window
   resize on another page (the `insResizeCharts_` pass).
8. **View-as-manager** — the Insights tab stays visible and works in
   the preview.

## Risks

- Digest deep-link query state (above) — gets its own smoke test.
- ~200 `ins-*` JS references — mitigated by keeping every inner id.
- Scroll-lock leaks — the Insights lock is removed entirely; IR-over-
  page uses IR's own lock (one place to verify).
- No cache/server/auth changes; rollback = revert + redeploy.
