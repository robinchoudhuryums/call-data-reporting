---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: FO-3 — the Batch D table and the Insights Outbound fold fetched the same windows through separate requests (one shared client store now); G3 — retire the Outbound report modal: #/report/outbound lands on the My Department Callbacks fold, the 6c release pair becomes the gate + the My Department surfaces
Files modified: apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/script-2-chrome.html, apps-script/department-dashboard/script-4-nav.html, apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/script-9-inbound-direct.html, apps-script/department-dashboard/OutboundReport.gs (comment only), tests/unit/cross-file-pins.test.js, tests/unit/html-include-structure.test.js, tests/unit/client-correctness.test.js, tests/unit/window-clamp.test.js, tests/unit/overview-outbound.test.js, tools/ui-harness/build-harness.js, tools/ui-harness/drive-admin.js, tools/ui-harness/drive-callbacks.js, tools/ui-harness/drive-cbdept.js, tools/ui-harness/drive-deptoutbound.js, CLAUDE.md, docs/operator-state.md, docs/regression-scenarios.md, docs/client-ui-conventions.md, docs/per-call-capture.md, docs/next-steps.md, .cycle/STATE.md

CHANGES:
FO-3 | script-5-dept.html, script-8-insights.html | obSummaryFetch_: ONE client store for getDeptOutboundSummary keyed dept|from|to -- an in-flight request queues the second caller, a held answer replays async (setTimeout 0), a failure is never held, Refresh clears it (obSummaryStoreClear_). OB_VIEW_ and INS_OB_ both read through it; neither mutates the shared payload (checked: local arrays + insObOwnScope_'s copy).
FO-3 | overview-outbound.test.js, drive-deptoutbound.js | the store is the only client sender (one call site) with its four rules pinned; the switch to Outbound sends each window ONCE between the two surfaces and both render (was 2 each).
G3 | dashboard.html, script-2-chrome.html, script-5-dept.html, script-9-inbound-direct.html | #outbound-modal + #outbound-report-btn removed; initOutboundReport boot step, COVERAGE_ADJUST_.outbound, reportReqSeq_.out removed; script-9 keeps only the shared renderers with REQUIRED targets (no modal defaults), the per-dept table views (OB_CBDEPT_DEFAULT_SORT_), outboundLoadUncalledInto_, outboundDownloadCsv_(data, sort), outboundSendEmailFor_.
G3 | script-4-nav.html, script-8-insights.html | '/report/outbound' -> { kind:'page', page:'dept', callbacks:true } on both the boot and the Back/Forward path; insCbDeepLink_ (only while obAllowed_): direction Outbound (persisted), Callbacks fold open (persisted), one-shot scroll after the first paint (data, empty, unavailable or failed). Otherwise a plain My Department landing.
G3 | OutboundReport.gs | the release comment above OUTBOUND_VETTING_GATE_ names the new release surfaces (comment only, no code change).
G3 | cross-file-pins.test.js | the 6c pin pairs the gate with #dept-dir-switch / #ins-ob-fold / #ins-cb-fold, fails if the modal or its menu item returns, and pins the page route.
G3 | html-include-structure / client-correctness / window-clamp tests | UI-5 drops the modal-wrapper assertions; CL-18's boot-step count 30 -> 29; the per-call clamp list drops the retired 'outbound-from'.
G3 | build-harness.js | getLocation is ASYNC like the real one (the deep link lands after boot's default page) and honours window.__HARNESS_HASH__ (default '' -- every other driver unchanged; the full ci:ui gate re-ran green).
G3 | drive-admin.js, drive-callbacks.js, drive-cbdept.js | drive-admin drops the Outbound modal entry; drive-callbacks swaps its modal re-generate check for the deep link (admin lands on the open, loaded, scrolled-to fold; manager gets a plain Inbound landing with no outbound request); drive-cbdept swaps its modal-sort check for the keyboard header sort drive-admin used to cover.
G3 | docs | S46 rewritten for the My Department release; S48/S57/S58/S59 reconcile steps no longer point at the modal; Operator State #63 steps 4-5; client-ui-conventions (Batch D, G1, G2 bullets); per-call-capture's Outbound report entry; next-steps row + the old runbook marked superseded; CLAUDE.md (drive-admin's EIGHT modals, S46 title).

TEST RESULTS: passed — `npm run ci` 2244 pass / 0 fail (exit 0, INV-16 + module-deps clean); `npm run lint:gas` clean; `CI=1 npm run ci:ui` all stages passed (drive-callbacks 25/25, drive-cbdept 19/19, drive-admin 106/106, drive-deptoutbound 32/32). Bites: removing insCbDeepLink_'s switch -> the admin deep-link check fails; re-adding #outbound-report-btn -> the 6c pin fails; reverting the route to a modal -> the 6c pin fails; the FO-3 switch check failed on the pre-store code (four requests). Live walks: S46 (pre-release half), S48, S59 -- NOT APPLICABLE here, need a deploy.
REGRESSION RISKS: (1) Bookmarked #/report/outbound links now open My Department rather than a modal -- intended; for a non-admin it is a plain landing, as the modal link was a no-op. (2) The shared store holds a window's answer for the page session (FIFO 8); a mid-day re-import is seen after Refresh, the same as before (OB_VIEW_ and INS_OB_ also held). (3) The harness getLocation change affects every driver; the full gate re-ran green.
INVARIANTS AT RISK: None — client + harness + comment; INV-39 / the 6c gate unchanged server-side; INV-17 not triggered (no server file removed).
NET SCORE: 1 production fix (FO-3: duplicate Neon-backed requests on every switch to Outbound) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- After deploy, walk S46's PRE-RELEASE half (manager: no outbound surface; #/report/outbound is a plain My Department landing) and S59's deep-link step | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The release itself (Operator State #63 step 4) when the owner finishes vetting: one commit flipping OUTBOUND_VETTING_GATE_ and un-hiding #dept-dir-switch / #ins-ob-fold / #ins-cb-fold.
- The modal's per-dept GROUPED agent table (PC-12 headings with subtotals) had a drive-admin check; its replacement is Batch D's grouped Outbound table, covered by drive-deptoutbound -- worth a glance that its subtotal headings are asserted there too.

DOCUMENTATION UPDATES NEEDED:
- None beyond what this batch wrote.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
