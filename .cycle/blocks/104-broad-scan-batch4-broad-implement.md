---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- C2-1 | Insights mixed-dept refusal landed in a hidden element; "Refreshing…" forever
- C1-1 | Overview hard error overwrote the skeleton; no Retry; stale error text became the loading state
- C2-2 | IR edit popover bypassed subqPickerScope_ (and did not commit checked agents)
- C1-2 | Init latest-date snap overwrote a user-picked window (async race)
- C2-3 | Last-good store fed an UNAVAILABLE Inbound payload / an errored Insights queue-health
- C1-4 | View-as did not re-scope the Overview escalation strip
- C2-4 | IR drill loader stranded on validation early-returns
- C1-6 | Dept switch left the previous dept's Transfer detail on screen
- C1-9 | getLatestDataDates failure was silent
- C1-5 | SWR pre-paint re-enabled Refresh while the live fetch was in flight
- C1-7 | Tile re-renders dropped the chart's solo markers
- C1-8 | Overview had no empty state for `depts: []`
- C1-10 | Chart-point click fired three summary fetches
- C2-6 | Double-submit on five Remove verbs + the escalation comment save
- C2-7 | Admin modal init failure offered no Retry
- D-6 | Combined grand totals lacked daysActive / ansPerDay (rendered '–')
- D-9 | `subScope:'subs'` shipped the child's qcd / csrTransfer / diagnostics under the parent's identity

Files modified:
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/script-2-chrome.html
- apps-script/department-dashboard/script-3-overview.html
- apps-script/department-dashboard/script-5-dept.html
- apps-script/department-dashboard/script-6-ir.html
- apps-script/department-dashboard/script-7-admin.html
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/script-9-inbound-direct.html
- apps-script/department-dashboard/script-10-escalations.html
- tests/unit/client-dead-ends.test.js (NEW)
- tests/unit/subqueue-access.test.js
- tests/unit/compute-summary.test.js
- tests/README.md

CHANGES:
C2-1 / C2-4 | script-8-insights.html, script-6-ir.html | ONE refuse helper per report (`insRefuse_`, `irRefuse_`). Insights: clears the launcher loader, then puts the message on the results status when results are up, else shows the form with the error; the no-dept, both date checks, prior.error and mixed-dept early returns route through it (the mixed message now says to open "Comparison & agents"). IR: clears the drill loader UNCONDITIONALLY, shows the form if hidden, sets the error; all five early returns route through it.
C2-2 | script-6-ir.html | `irApplyEditPopover_` commits the checkbox state (`irApplyCheckedAgents_`) then runs `subqPickerScope_`; a mixed-dept pick is refused with a visible results-status error; the dept comes from the scope result.
C1-1 | script-3-overview.html | `ovShowLoadError_` hides the skeleton children and shows a `.ds-note[role=alert]` with the escaped message + a Retry (`ovLoad_(false)`); `ovClearLoadError_` reverses it on every non-silent load. Nothing writes `ov-loading`'s textContent any more.
C1-2 | script-2-chrome.html, script-3-overview.html | `datesTouched_` flag: set by the From/To change listeners, the preset chip onPick and the chart-point deep link; the init `getLatestDataDates` success handler snaps From/To only while it is false (still records `latestDqeIso_`).
C2-3 | script-9-inbound-direct.html, script-8-insights.html | `reportLastGoodWrite_` skipped when `meta.available === false` (Inbound) or `queueHealth.error` (Insights) -- the server already skips its own cache put for the latter.
C1-4 | script-3-overview.html | `applyViewAs_` calls `loadEscBadge_()` on enter and exit; `escApplyBadge_` already narrows the strip to `viewAsDept_`, it just never re-ran.
C1-6 | script-5-dept.html | The dept-switch block hides `#dept-transfer-section` with the QCD snapshot + missed section.
C1-9 | script-2-chrome.html | Failure handler toasts (8 s, error tone), beacons `reportClientIssue_('load-failure', …)`, then the unchanged `refresh()` fallback.
C1-5 | script-5-dept.html | `onData` re-enables Refresh only when `!opts.swr`; `onError` still re-enables unconditionally.
C1-7 | script-3-overview.html | `ovRenderTiles_` ends with `ovSyncTilePins_(ovChartInstance)` so every caller (period bar, dept switch, view-as pre-paint, ovRender_) inherits it.
C1-8 | script-3-overview.html | `ovEmptyStateHtml_()` (role=status, admin vs manager hint) replaces a blank grid when `depts` is empty.
C1-10 | script-3-overview.html | `ovRouteToDept_` sets From/To (+ `datesTouched_`, clears the active preset) BEFORE dispatching the selector change (whose handler refreshes); a same-dept click refreshes once via `else if (datesSet)`; the second unconditional `refresh()` is gone.
C2-6 | script-7-admin.html, script-10-escalations.html | `mutationBusy_(key)` / `mutationDone_(key)` in-flight guard on `alCfgRemove_`, `alDgRemove_`, `alQrRemove_` (which also gained a 'Removing…' status + a success status), `acAgentRemove_` + `acRemoveRow_` (shared key), and `escSaveComment_` (per-row key); released on both handlers.
C2-7 | script-7-admin.html | `adminInitError_(elId, err, retryFn)`: stores the loader's original markup once, renders an escaped `.ds-note[role=alert]` + Retry that restores the markup and re-runs the init; wired for al-/of-/ac-/dc-loading.
D-6 | Data.gs | `computeSummary_` attaches `totals.activeDayKeys` NON-ENUMERABLY (never serialized to the cache/payload, invisible to deep-equal); `combineSummaries_` unions it across parts for `grand.daysActive` and derives `grand.ansPerDay` from the de-duplicated grand answered; parts without the set fall back to the largest per-dept count.
D-9 | Data.gs | `getDepartmentSummary` computes `primary` as the REQUESTED dept always (a separate `computeSummary_` in 'subs' scope, which the client never sends); `combineSummaries_`'s single-part path grafts the primary's qcd / csrTransfer / diagnostics when the primary is not the part.

TEST RESULTS: passed — node --test 1619/1619 (was 1601; +13 client-dead-ends source pins, +4 subqueue-access D-6/D-9 incl. a getDepartmentSummary subs-scope end-to-end, +1 compute-summary D-6). INV-16 guard clean. `npm run lint:gas` clean (72 files, 3 projects). `npm run ci:ui` RUN HERE after installing playwright into tools/ui-harness (the preinstalled Chromium served it): all eight asserting stages passed. Five pins bite-checked with scripts/bite.sh (C1-5, C2-6, D-6 union, D-9 graft, D-9 end-to-end primary) — all BITE. NOTE: the block's earlier belief that ci:ui cannot run in this container is wrong; `npm i playwright` in tools/ui-harness is enough.

REGRESSION RISKS:
- C1-2: a window the user picked BEFORE the init date lookup returns is now kept — including a preset like "Last 7 days" resolved against today (the resolver already ends yesterday and the clamp uses `latestDqeIso_`, which is still recorded). Intended.
- C1-10: a dept switch via the chart now relies solely on the selector's change handler to fetch; the handler already calls `refresh()` (pinned by the header-switch drive). The `setPage('dept')` stale-dept guard is unchanged.
- C1-1: the `#ov-load-error` node lives inside `#ov-loading`; `ovRevealBody_` hides the whole loader as before, so a cached paint after an error still hides it.
- C2-6: the guard keys are per VERB (per row for comments), so two different verbs can still run concurrently as before; a verb whose RPC hangs past the Apps Script ceiling stays busy until the failure handler fires (Apps Script always fires one).
- D-6: `activeDayKeys` is non-enumerable, so any consumer that clones `totals` via spread/JSON loses it — only `combineSummaries_` reads it, and it falls back to the largest per-dept count. `deptGroups[].totals` is the same object; the key stays hidden there too.
- D-9: 'subs' scope now costs one extra `computeSummary_` — a scope the client no longer sends (summary:v22 key unchanged; the payload for 'own'/'all' is byte-identical).
- Cache: no INV-30 bump. D-6 adds two fields to a combined payload (a cached pre-fix combined payload renders the '–' it did before until the freshness tag moves); D-9 changes only the latent 'subs' scope.

INVARIANTS AT RISK: None. INV-01 (no new public writes; every change is client or read-side), INV-30 (no aggregation-rule change: the combined `daysActive` is a NEW field, per-dept subtotals and every existing total untouched — pinned), INV-37 (`setPage`/`refresh` ownership unchanged), INV-51 (QCD snapshot still never merged; D-9 makes it the requested dept's in the one scope where it was not).

NET SCORE: 11 − 0 = 11
(a: would have fired this month — C2-1 YES, C1-1 YES, C2-2 YES, C1-2 YES, C2-3 YES, C1-4 YES, C2-4 YES, C1-6 YES, C1-9 NO, C1-5 YES, C1-7 YES, C1-8 NO, C1-10 YES (perf only), C2-6 NO, C2-7 NO, D-6 YES, D-9 NO (latent scope); b: new failure mode — NO for all 17.)

OPERATOR ACTIONS / DEPLOY:
- None — no Script Property, trigger, sheet or migration. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `scripts/deploy.sh . <dashboard-deployment-id>` (or `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy). Data.gs + eight client fragments changed; run `npm run ci:ui` as part of the gate (deploy.sh does).

FOLLOW-ON ITEMS:
- The IR / Insights RPC FAILURE handlers still call `insSetFormError` / `irSetFormError` directly (not via the refuse helpers) — they already show the form and clear the loaders, so no dead end; unifying them is cosmetic.
- 11 legacy `window.confirm` callsites remain (the html-include-structure ratchet); three of the C2-6 verbs use them. Untouched (out of scope).
- `alQrReload_` re-renders the subscribers table but does not clear a prior 'Removing…' status on its own; the success handler now sets a success status, but a failed reload after a successful remove keeps that status (cosmetic).
- Pre-existing load-sensitive flake noted in Batch 3 (`neon-mirror-tail.test.js` B1) did not recur in this session's runs; still untouched.
- Batches 5–9 of the scan plan remain; DD-2 flip is the operator's (run `probeAnswerRateFormulas()`, then set `ANSWER_RATE_FORMULA=answerable`, Operator State #69).

DOCUMENTATION UPDATES NEEDED:
- tests/README.md: DONE in this batch (client-dead-ends listed).
- .cycle/STATE.md: the "ci:ui cannot run in this container" note in the Batch 1–3 entries is stale — `npm i playwright` in tools/ui-harness makes it run (recorded in this batch's entry).
- No CLAUDE.md / docs change required: no convention, invariant, Script Property, cache version or Operator State item changed.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
