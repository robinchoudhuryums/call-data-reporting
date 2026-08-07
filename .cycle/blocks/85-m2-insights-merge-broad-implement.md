---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: M2 — Insights→My Department merge phase 2 (controls reconciliation), per docs/insights-merge-plan.md
Files modified: apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script-2-chrome.html, apps-script/department-dashboard/script-4-nav.html, apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/styles.html, docs/insights-merge-plan.md, docs/client-ui-conventions.md, docs/regression-scenarios.md, CLAUDE.md

CHANGES:
M2-authority | script-8, script-5, dashboard.html | The dept controls row is the page's single date authority. New insSyncToDeptWindow_ converges the region — from refresh() (open + rendered + window moved → re-run via insApplyWindow_, the validated shared tail) and from the region toggle-open (stale closed region re-runs on next open; compare-rendered-meta-vs-dept, no flag). SKIPS while insLauncherAutoRun_/insAutoRunPending_ is armed (that run owns its window — chips' 30-day promise / share-link windows never race a dept-window run). insEnsurePage_ first-open seeds ins dates from the dept inputs (overriding restored prefs dates); priority ends share link > chip/handoff > dept window > prefs > defaults. #ins-hdr-controls (region header From/To + Quick-select) hidden, wiring inert for M4.
M2-headline | script-8, dashboard.html, styles.html | insRegionHeadSync_ fills #ins-region-head on every render: "% answered · missed rings · abandoned % · from → to" (teamStats fields are STAT OBJECTS — read .formatted; caught live when the first probe rendered "[object Object]"); the static #ins-region-sub yields once a headline exists.
M2-decisions | docs/insights-merge-plan.md | Open-state persistence: NONE (restoring open=true would re-fire the report RPC on every dept visit — laziness contract). Exports: per-region menus stay.
M2-retire | script-4, script-2 | adoptSharedWindow_ (R9-3 silent adoption) deleted; setPage's dept branch drops the adoptedWin_ term; pageActiveWindow_/recordPageWindow_ kept ONLY as the R11-C2 dwell-prefetch feed (comment says so).
M2-rearm | script-8 | Region toggle-open recreates charts from insLastData (insRenderCardsChart_ when view=chart / insDrawTrendChart_ when fold open / insRenderDeferredCharts_ when detail open; destroy+create, the C3-safe path) — closes the collapsed-mid-generate 0×0-canvas exposure flagged in the M1 block.
M2-docs | docs/*, CLAUDE.md | Plan doc M2 → shipped with decisions; client-ui-conventions header-dates bullet rewritten + region bullet extended; CLAUDE.md conventions index line; scenarios S14/S18/S19/S32/S37 reworded to the dept-date-authority model.

TEST RESULTS: passed — 651/651 node --test, INV-16 guard, npm run ci:ui 28+16+30+14. Live-DOM probe: header date row hidden; first open seeds ins dates = dept dates; dept date change with region OPEN re-syncs inputs + re-runs; with region CLOSED no-op, then reopen converges + re-runs; charts alive after the close/reopen cycle; headline renders real values ("90.5% answered · 190 missed rings · 4.77% abandoned · window"); zero console errors. (Probe note: the harness mock returns one fixture payload for any window, so the rendered meta stays the fixture's — the sync mechanics were verified via input convergence + re-run firing, not payload change.)

REGRESSION RISKS:
- Saved-prefs DATES are no longer honored (dept window wins on open). Compare-mode/agent prefs still restore. Deliberate — one-window model; a user who always wants "last month" sets it on the dept controls.
- In production the sync compares rendered meta vs dept inputs; the server echoes the request window into meta, so convergence terminates. If a future server change ever stopped echoing from/to, the region would re-run once per open/refresh (bounded, no loop) — noted here so it isn't a mystery.
- A dept SWITCH (window unchanged) does not re-run an open region — it keeps the prior dept's report until a window change or reopen-after-close. Flagged as the M3 dept-pill work's problem (dept identity belongs there).
- Share-link windows survive until the next dept-window change/refresh converges the region — the one-window model working as intended, but a recipient who refreshes loses the emailed window (its run already rendered; the headline + pill state the change).

INVARIANTS AT RISK: None new — INV-45 semantics preserved (first open auto-generates, now over the dept-seeded window); no cache changes (requests carry explicit from/to as before); no server changes (INV-01 untouched).

NET SCORE: 1 − 0 = 1 (the collapsed-mid-generate 0×0-canvas exposure was a real, reachable defect on a 30–60s cold generate; the rest is the planned restructure)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh . <dashboard-deployment-id>`)

FOLLOW-ON ITEMS:
- M3 (scope polish): dept pill on the region header for parent depts + the dept-SWITCH convergence gap above; "See missed calls" as in-page scroll; Agents section default → Gap vs team; A/B panel visibility scoping
- M4 (retirement): delete the inert #ins-hdr-controls markup + insInitHeaderDates_/insSyncHeaderDates_, the lens switcher, handoff/launcher setPage detours, dead router branches, the data-page belt in irDrillToAgent_, remaining insights-side recordPageWindow_ call
- insSavePrefs_ still saves dates it no longer restores meaningfully — M4 slims the prefs blob

DOCUMENTATION UPDATES NEEDED:
- None beyond those shipped in this commit
---END BROAD SCAN IMPLEMENTATION SUMMARY---
