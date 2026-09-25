---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- UI-1: Escape on a layer stacked over a report modal closed the report too
- UI-2: closing Help (or the call-path overlay) over a report dropped the report's focus trap and scroll lock
- UI-3: view-as-manager still drew the admin-only YTD Company line
- UI-4: a failed Escalations init left a spinner, gave no Retry, and sent no beacon
- UI-5: the Outbound "not called back" drill could land on a newer report
- UI-6: the Inbound insurer drill cache was keyed by insurer name only
- UI-7: the Agent Day roster picker kept whichever response landed last
- UI-11: the Coaching worklist had a stale-load race, and a flag could be closed twice
- UI-8: four generated inputs were labelled only by a placeholder
- UI-9: the insurer drill row exposed no expanded state. `tr.trp-row` was deliberately left unchanged (see FOLLOW-ON ITEMS)

Files modified:
apps-script/department-dashboard/script-1-core.html, script-2-chrome.html, script-3-overview.html,
script-4-nav.html, script-5-dept.html, script-7-admin.html, script-8-insights.html,
script-9-inbound-direct.html, script-10-escalations.html, styles.html, CompanyOverview.gs;
tests/unit/html-include-structure.test.js, tests/unit/overview-chart-answered.test.js;
tools/ui-harness/build-harness.js, tools/ui-harness/drive-admin.js, tools/ui-harness/README.md;
docs/client-ui-conventions.md, docs/fix-history.md, docs/module-dependencies.md (regenerated);
.cycle/STATE.md, .cycle/blocks/195-broadscan-0923-plan.md

CHANGES:
UI-1 | script-1-core, script-2, script-4, script-5 | New `escapeLayerPush_` / `escapeLayerRemove_` and ONE capture-phase `document` Escape dispatcher. It closes only the top layer and stops the event, and it steps aside while a `.ds-confirm-overlay` is up. Help, the chart tips and the "↳ path" overlay now register through it, and their bubble-phase Escape listeners are gone. The report modals stay the base layer.
UI-2 | script-1-core, script-2, script-5 | New `layerIsShown_` (a computed-display check). Help stashes the outer trap and `body.style.overflow` on open. On close it re-arms that trap (whose autofocus lands inside the report) and restores the lock; with nothing underneath it keeps the old behaviour. Found while fixing: `callJourneyHide_` re-armed only when `offsetParent !== null`, which is always false for a `position:fixed` `.modal`, so it never re-armed. It now uses `layerIsShown_` and is idempotent.
UI-3 | CompanyOverview.gs, script-3 | `getOverviewChartTrend` resolves view-as exactly as `getCompanyOverview` does (admin + real dept → synthetic manager; it only ever narrows). The strip still runs on serve, so the cache key is unchanged. Usage rows log the real caller. On the client, `ovYtdScope` + `ovYtdFresh_` key the cached payload by view-as scope; `applyViewAs_` re-fetches when YTD is on screen; a response for a superseded scope is dropped and re-requested.
UI-4 | script-10 | The init failure clears `#esc-loading` and renders the error with an inline Retry, which re-runs `escEnsureInit_` with the same continuation. It also calls `reportClientIssue_('load-failure', 'Escalations init failed: …')`.
UI-5 | script-9 | `outboundUncalledSeq_` is bumped per request AND per report render. The render also restores the drill button from `data-idle-label`. Both handlers drop superseded responses.
UI-6 | script-9 | `inboundDrillKey_` = (from, to, dept, insurer). The success handler also requires the drill row to still be in the DOM and the key to be unchanged.
UI-7 | script-10 | `adAgentsSeq_` token on `adLoadAgents_`, checked in both handlers.
UI-11 | script-7 | `coachingLoadSeq_` token on `coachingLoad_`. Per-flag `coachingClosing_` guard + `coachingSetRowBusy_` disable the row's Resolve/Dismiss until the round trip (or Cancel) ends.
UI-8 | script-7, script-8 | aria-labels on: Outlier Fix's add-to-roster dept select and extensions input (both name the agent), the Coaching note input, and the Insights saved-view name.
UI-9 | script-9, styles | Per the a11y contract, the insurer row's first cell holds a `<button class="inbound-insurer-toggle" aria-expanded>`, set by `inboundSetRowExpanded_`. The row-level `tabindex` and keydown are removed (they would toggle twice), and the row stays the mouse target.
tests | html-include-structure, overview-chart-answered | Source pins:
  - the UI-1 wiring and the absence of the bubble listeners
  - the four race guards
  - the UI-8 labels
  - the UI-9 button, with no row keydown
  - the UI-3 client scope key
  UI-3 also gets a behavioural test of the server view-as strip (six role/dept cases). Every new test was bite-checked against HEAD and fails there.
ui-harness | build-harness, drive-admin, README | `__HARNESS__.failOnce[rpc]` failure injection. drive-admin gains two walks:
  - A stacked-layer walk over a real Agent Day report. For each of Help, the chart tips and the call path, Escape closes only the layer, and the report keeps its trap (12 tabs) and scroll lock. Escape then still closes the report.
  - A UI-4 walk: the loader is cleared, Retry and the beacon appear, and Retry recovers.
  Both bite: against HEAD the report closes, overflow is cleared, 12/12 tabs escape, and there is no Retry or beacon.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 1852/1852.
- INV-16 guard in sync; module-deps `--check` up to date; `CI=1 npm run lint:gas` clean.
- `CI=1 npm run ci:ui`: all stages passed (drive-admin 96/96).
- Regression Scenarios overlapping the change (walked by the rendered gate where a driver exists; the rest are live/manual): S20/S36-style admin modals, S39 keyboard walk (drive-f13 green), S23/S25 Overview (drive-smoke green). S41/S42 are perceptual and were not walked.

REGRESSION RISKS:
- The Escape dispatcher swallows Escape whenever the stack is non-empty. A layer closed by some path that skips `escapeLayerRemove_` would cost one Escape press, and its close would re-run. All three layers remove themselves on every close path, and each close fn is idempotent (Help: `isOpen`; call path: display check; tips: `!pop`).
- Help opened over a report now returns focus to the report's first focusable control, not the FAB.
- The insurer row is no longer a tab stop itself; its button is. The keyboard path is the same (Tab to it, Enter/Space).
- The view-as YTD payload is now fetched per scope: one extra RPC on a view-as enter/exit, and only while YTD is selected.

INVARIANTS AT RISK: None.
- INV-39 is strengthened: the YTD strip now honors view-as.
- INV-30: no cache key or version change; the strip is post-cache.
- INV-01: no write path touched.
- INV-37: `setPage` is unchanged.

NET SCORE: 2 − 0 = 2
- Production this month: UI-1 YES (any Escape on a path drill opened from Inbound, Outbound, Agent Day or Caller Lookup) and UI-2 YES (Help from the FAB over a report).
- Not this month: UI-3, UI-4, UI-5, UI-6, UI-7, UI-11, UI-8 and UI-9. Each needs rare timing, a failure, or an assistive tech the known users don't run.
- New failure modes: none. The swallowed-Escape risk is guarded and documented.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or `scripts/deploy.sh .`), then Deploy → Manage deployments → New version. After the deploy, walk the stacked-layer path by hand once: Inbound report → heatmap "↳ path" → Escape.

FOLLOW-ON ITEMS:
- `tr.trp-row` (Team Rings panel) was NOT given `aria-expanded`. It JUMPS to the agent's table row rather than expanding, so the finding's premise does not hold. Its real a11y gap is that the action is described only by `title`; an `aria-describedby`, as on the Overview tiles, would fix it.
- `tr.ins-qh-row` (script-8 ~2273) carries `tabindex` + `aria-expanded` on the `<tr>` itself, which departs from the button-in-cell contract. This is pre-existing and out of scope.
- NOT verified: other in-modal menus with their own Escape handling (the IR Export menu at script-6 ~372, and the core `setOpen` dropdowns) may also bubble Escape to the report. They could join the layer stack.
- `escEnsureInit_` has no in-flight guard, so two quick page entries issue two init RPCs. This is harmless (last write wins, same data).
- Telemetry inconsistency: `getCompanyOverview` logs the EFFECTIVE (synthetic manager) user under view-as, while the YTD endpoint now logs the real caller.
- Carried from earlier batches:
  - `callJourneyDeptPredicate_` does not roll up the PCR-2 labels.
  - DeptConfig `qcdQueues` is stored raw.
  - The CRT-4 shape is unchecked on the NeonMirror/dup-guard DO-UPDATE paths.
  - The S2C-1 `agentBusy` half is still open.
  - Alerts has no INTERRUPTED signal.
  - ENG-4 needs a re-scope.
  - The callback table needs `outboundReport:v5`.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit. It updates:
  - client-ui-conventions: the Escape layer-stack rule, plus the `layerIsShown_` / `offsetParent` trap in the dialog bullet
  - fix-history: a Batch 7 section
  - the ui-harness README: the new walks and `failOnce`
- The README's "six admin modals" count stays for DOC-6 (Batch 10).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
