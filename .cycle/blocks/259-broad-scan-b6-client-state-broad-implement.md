---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F47 A YTD chart range restored from localStorage was never fetched at boot -- the chart drew 90 days under a lit YTD button, and clicking YTD did nothing
- F48 The YTD session cache was never refreshed after the morning ingest
- F49 The IR edit popover skipped the R30 latest-date clamp (its comment claimed otherwise), biasing the prior-period deltas
- F50 Saving or removing an alert config row left the old preview armed, so "Send" emailed under the new config with the old preview's confirmation
- F16 The digest's "See the full breakdown" link carried no dept -- a multi-dept recipient landed on another dept's Insights with this dept's agent list
- F51 The silent 5-minute Overview refresh blanked the agent table, and a failed refresh threw the good rows away
- F52 A roster fetch after a failed one showed the old error + Retry as its loading state (IR + Insights pickers)
- F25 The latest data dates were re-read every ~10 minutes, not the documented 5
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/script-2-chrome.html
- apps-script/department-dashboard/script-3-overview.html
- apps-script/department-dashboard/script-4-nav.html
- apps-script/department-dashboard/script-6-ir.html
- apps-script/department-dashboard/script-7-admin.html
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/Digest.gs
- tests/unit/client-lifecycle.test.js, tests/unit/client-correctness.test.js, tests/unit/overview-chart-answered.test.js, tests/unit/digest-insights.test.js
- tools/ui-harness/gen-payloads.js, tools/ui-harness/build-harness.js, tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/module-dependencies.md (regenerated)
- .cycle/STATE.md, .cycle/blocks/259-broad-scan-b6-client-state-broad-implement.md

CHANGES:
F47 | script-3-overview.html | ovRenderChart_ starts the YTD fetch (next tick) when YTD is selected, not loading and not fresh; the 90-day view fills in meanwhile and a failed fetch reverts to 90 with a toast as before
F48 | script-3-overview.html | ovYtdFresh_ also requires ovYtdForLatest (the Overview latestDate the fetch was REQUESTED for) to equal ovLastData.latestDate, so the next render after an ingest refetches once (no loop if the server's date differs)
F49 | script-6-ir.html | irApplyEditPopover_ clamps ir-edit-from/to to latestDqeIso_ before reading them and deriving the prior window, and shows the correction as a warn status after the render; runIrReport's comment corrected
F50 | script-7-admin.html | new alInvalidatePreview_ (seq bump, clear preview, disable Send, clear results, optional warn); called on config save + remove success, the date change and the init render; an in-flight preview whose token moved is dropped
F16 | Digest.gs, script-4-nav.html | digestDeepLink_ leads with dept=<encoded dept>; new shareApplyDeptParam_ (the /dept provider's guarded selector rule, now shared) is applied FIRST by the Insights provider, which refreshes when only the dept moved and re-ensures the Insights roster so the link's agent pick lands on the linked dept; insCarryLinkWindowToDept_ returns whether it re-fetched
F51 | script-3-overview.html | ovRenderUserTable_ keys the rows by dept|from|to; a same-window re-render repaints in place without blanking, and a failure keeps the rows with a warn note; a new window blanks and errors as before
F52 | script-6-ir.html, script-8-insights.html | new rosterLoaderShowLoading_ restores the loader's original skeleton (captured on first use; plain loading text if already overwritten) before each roster fetch, in both pickers
F25 | script-2-chrome.html | the age gate uses LATEST_DATES_MIN_AGE_MS (5 min - 30 s), so a reply that lands a few seconds after its tick no longer skips the next tick; the visibilitychange throttle stays

TEST RESULTS: passed -- 2467 tests (2466 pass, 0 fail, 1 pre-existing skip; +7 new in client-lifecycle, digest-insights extended). Two pins updated for the intended change: client-correctness CL-17 (the provider call is now `windowMoved = insCarryLinkWindowToDept_(params)`) and overview-chart-answered UI-3 (ovYtdFresh_ gains the F48 clause). lint:gas clean, module-deps regenerated (Digest.gs line count) and up to date, INV-16 guard in sync. ci:ui: all stages passed, incl. the new drive-smoke stage "YTD range restored at boot" (admin + manager; getOverviewChartTrend now has a real-payload mock). Bites: 12/12 unit + 1 rendered (dropping the F47 kick reproduced the bug: 0 fetches, 64 labels under a lit YTD button).
REGRESSION RISKS:
- F47/F48: a tab with YTD selected now makes up to two YTD fetches on a boot whose SWR cached paint carries an older latest date than the live payload (both server-cached). A failing getOverviewChartTrend now toasts at boot for a YTD-saved viewer -- previously it silently drew 90 days.
- F16: the '/dept' provider now goes through the shared helper -- same outcomes (pinned); the Insights link re-ensures the roster only when the dept actually moved.
- F51: a same-window refresh no longer shows "Loading agent detail…"; the rows swap when the reply lands.
INVARIANTS AT RISK: None (INV-37 setPage/refresh unchanged; INV-01 untouched -- no new server write; INV-04 exact-match dept rule preserved in shareApplyDeptParam_).
NET SCORE: 5 − 0 = 5 (production fixes: F47, F48, F16, F51, F25; F49, F50, F52 need a rarer path and are counted NO)

OPERATOR ACTIONS / DEPLOY:
- None
Deploy: Department Dashboard -- `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Insights SHARE_STATE_ collect() still omits dept, so "Open in new tab" / saved views of a non-default dept land on the viewer's default dept (same class as F16, not in scope).
- A header click on the Overview mini-table during a NEW-window load re-sorts the previous window's rows (ovUserRows_ is kept until the reply lands) -- pre-existing.
- Batches 7-10 of the cycle-259 plan remain.

DOCUMENTATION UPDATES NEEDED:
- None beyond docs/client-ui-conventions.md (updated in this batch: the digest link's dept param)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
