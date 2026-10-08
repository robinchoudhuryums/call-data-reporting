---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (1) ALIGN — the Batch E Insights Outbound fold (#ins-ob-fold) follows the direction switch (Outbound / Both only), like the G1 Callbacks fold; (2) G2 — Callbacks by department as an admin-only-forever, lazy section on the Overview (#ov-cbdept-fold), drawn by the modal's renderers with its own view
Files modified: apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script-3-overview.html, apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/script-9-inbound-direct.html, apps-script/department-dashboard/styles.html, tests/unit/cross-file-pins.test.js, tools/ui-harness/drive-cbdept.js (new), tools/ui-harness/drive-outbound-e.js, tools/ui-harness/drive-subqueue.js, tools/ui-harness/drive-agentpanel.js, tools/ui-harness/ci.mjs, CLAUDE.md, docs/client-ui-conventions.md, docs/per-call-capture.md, docs/regression-scenarios.md, docs/next-steps.md, .cycle/STATE.md

CHANGES:
ALIGN | script-8-insights.html | insObSync_ hides unless obEffectiveDir_() is out/both (obAllowed_ inside it, so still admin-only until 6c and hidden in View-as).
ALIGN | script-5-dept.html | obViewSync_ re-syncs the Outbound fold (from insLastData) as well as the Callbacks fold on a direction change.
ALIGN | cross-file-pins.test.js | the 6c pin's E1 assertion now pins obEffectiveDir_ + hide-on-Inbound.
ALIGN | drive-outbound-e.js | asserts the fold is hidden and unfetched on Inbound, switches to Outbound for its checks, and proves "same windows never re-fetch" on an Inbound -> Both switch (the old Refresh-based check could no longer separate an Insights re-fetch from the Batch D table's deliberate Refresh refetch, which uses identical arguments).
G2 | script-9-inbound-direct.html | the per-dept callback table renderers take a VIEW (obCbDeptView_: element prefix, own sort, last payload; OB_CBDEPT_MODAL_ is the default, obCbDeptSort_ aliases its sort): obCbDeptCmp_/obCbDeptOrder_ take a sort, outboundPaintCbDept_/outboundRenderCbDept_ take a view; ONE column list (OB_CBDEPT_COLS_ + obCbDeptTheadHtml_) builds both tables' header; outboundDownloadCsv_(data, sort) writes the cbdept block in the caller's order.
G2 | dashboard.html | the modal's static thead replaced by an empty thead the helper fills; new #ov-cbdept-fold at the bottom of #ov-body (data-admin-only + display:none): window segmented control (Last 7 / 30 days / 3 months), dates, CSV, state note, tiles, the grouped table with its note.
G2 | script-3-overview.html | OV_CBDEPT_ + ovCbDeptSync_ (fetches only while open AND for an admin; company view department ''; window from datePresetRange_; one fetch per window, in-flight de-dupe, failed read retries on next open), ovCbDeptRender_ (unavailable / empty / sheet-fallback states, headline, tiles via outboundCallbackTilesHtml_, table via outboundRenderCbDept_ with the Overview view), wiring (toggle, window, CSV). ovLoad_ never calls it.
G2 | styles.html | .ov-cbdept-* layout; the table scrolls inside its own wrapper.
G2 | cross-file-pins.test.js | new "G2" pin: admin-only markup independent of the gate, the open+admin guard, the company-view call, ovLoad_ never touching it, exactly two call sites.
G2 | drive-cbdept.js + ci.mjs | new BLOCKING stage, 19 checks: admin sees it closed + unfetched on landing; one company-view fetch on open for the shown window; 5 tiles; 8-column shared header; default order with child under parent and unmapped last; total row; headline; sort keeps grouping; keyboard expand; CSV bytes in on-screen order, injection-safe; window switch fetches once; reopen does not; the MODAL keeps its own default sort; View-as hidden; no unmocked RPCs; 360 px; manager hidden and never fetches even forced open; no page errors.
G2 | drive-subqueue.js, drive-agentpanel.js | their CSV export clicked the FIRST page-wide "Download CSV" button; the new Overview section's button now precedes the My Department one, so both target #dept-export-menu [data-action="csv"] explicitly.
G2 | docs | client-ui-conventions (E1 gate sentence + G2 bullet), S48 rewritten for the Overview, S58 direction step, per-call-capture CB-1 note, CLAUDE.md driver list + S48 index, next-steps row.

TEST RESULTS: passed — `npm run ci` 2243 pass / 0 fail (exit 0, INV-16 + module-deps clean); `npm run lint:gas` clean; `CI=1 npm run ci:ui` all stages passed (new 19/19; drive-outbound-e 21/21; drive-callbacks 24/24). Bite checks: the open+admin guard removed -> the manager check fails (1 request) with BOTH role builds fresh; the Overview view sharing the modal's sort -> the modal-order check fails; ovLoad_ calling the section -> the G2 pin fails; insObSync_ ignoring the direction -> the 6c pin fails. Live scenario walks (S48, S58, S59) NOT APPLICABLE here (need a deploy + live Neon) -- owner walk.
REGRESSION RISKS: The modal's cbdept header is now JS-built (filled on first render) -- covered by drive-cbdept's modal check (8 headers, default sort) and drive-admin. Insights Outbound fold no longer shows on Inbound for admins (owner-requested behavior change). Two existing drivers' CSV selectors tightened (their assertions unchanged).
INVARIANTS AT RISK: None — client only; INV-39 (admin-only fields) unaffected; the Overview payload/cache (companyOverview:v28, INV-30) untouched -- the section is a separate RPC; CSV writer still csvSafeCell_-routed.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature steps)

OPERATOR ACTIONS / DEPLOY:
- Walk S48 (now on the Overview) and S58's direction step as the admin after deploy | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Batch D's obViewSync_ re-sends getDeptOutboundSummary when it runs twice while the same window's request is still in flight (key set, data/error not yet back) -- a duplicate, cached server-side but wasteful; a one-line in-flight guard like OV_CBDEPT_.inFlight would fix it.
- Manual driver runs must rebuild BOTH roles (`node build-harness.js` and `node build-harness.js manager`); a stale manager page made one manager check pass vacuously during development. ci:ui always rebuilds both, so the gate was never affected -- a README note in tools/ui-harness may be worth adding.
- G3 (retire the modal: router repoint, 6c pin, drivers, S46, #63, the stale OutboundReport.gs release comment) remains and must land before the 6c release.

DOCUMENTATION UPDATES NEEDED:
- None beyond what this batch wrote.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
