---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- (found by ST4, fixed with owner approval 2026-10-15) after leaving View-as on the same dept and window, the admin's UX-2 brief came back WITHOUT its Callbacks row -- it had been re-rendered during the preview (Outbound view hidden) and nothing re-rendered it on exit, the F21 blind spot
New capabilities (G/ST):
- ST4 manager-release readiness: tools/ui-harness/drive-crossstate.js, a new BLOCKING ci:ui stage that walks the cross-state SEQUENCES on My Department before the UX-2 / 6c gates open -- dept switch with the brief open, dept switch in the Outbound view, the brief's Callbacks row vs the dept on screen, View-as in and out, the Callbacks jump from Both vs Inbound (F24)
Files modified: apps-script/department-dashboard/script-3-overview.html, tools/ui-harness/{drive-crossstate.js (new), build-harness.js, gen-payloads.js, ci.mjs, README.md}, tests/unit/insights-brief.test.js, CLAUDE.md, .cycle/STATE.md

CHANGES:
ST4 | tools/ui-harness/drive-crossstate.js (new), ci.mjs, README.md, CLAUDE.md | 18 asserting checks: CSR brief on its own payload with no default label; Sales after a switch -- its rate (none of CSR's left), "Default 80% target" (G2), green tier; Outbound on CSR lists the payload's agents; after a switch in Outbound the direction holds, the tables never overlap, no CSR row survives; the Callbacks row quotes callbacks only if they were fetched for the dept on screen (F20); View-as hides brief + switch and falls back to Inbound on the previewed dept; leaving it brings the saved Outbound back, the brief WITH its Callbacks row, on the payload of the dept on screen; the Callbacks jump keeps Both and moves Inbound to Outbound (F24); no unmocked RPCs, no page errors. Stage added after drive-deptoutbound; CLAUDE.md "THIRTEEN" -> "FOURTEEN ASSERTING stages".
ST4 | tools/ui-harness/gen-payloads.js, build-harness.js | real Sales Insights captures (30-day + single-day) from the server code; getInsightsReport routes by department -- with one CSR payload for every request a stale brief read as correct.
Fix | script-3-overview.html (applyViewAs_) | after the data-view-as attribute is set/removed (and the F21 trend redraw), re-render the brief from insLastData -- obAllowed_ reads the switch's computed display, which that attribute decides.
Fix | tests/unit/insights-brief.test.js | source pin: applyViewAs_ calls insRenderBrief_(insLastData) after the attribute change (bites in node --test, not only in the browser gate).

TEST RESULTS: passed -- 2528 tests, 0 fail (TZ=America/Chicago); lint:gas clean; module-deps unchanged; ci:ui ALL stages passed including the new cross-state stage (18/18). Bites: rendered -- removing the brief re-render fails the two Callbacks-row checks; a mock serving CSR's Insights for every dept fails the three dept-switch checks; unit -- the source pin bites. The first driver run (before the fix) failed the Callbacks-row check, which is how the bug was found.
Regression scenarios: S61 (Insights brief) PASS -- the brief's rules are untouched, it is only re-rendered at one more moment; S2 (admin switches departments) and S57 (Inbound / Outbound / Both) PASS -- now walked by the driver; S54 (Back/Forward) not affected.
REGRESSION RISKS:
- applyViewAs_ now re-renders the brief from the HELD payload: when a preview switches dept, the brief is briefly painted from the previous dept's payload -- but it is hidden while previewing (data-admin-only), and refresh() repaints it for the previewed dept straight after.
INVARIANTS AT RISK: None. INV-37 (setPage owns the page swap; refresh writes the title on the dept page) untouched; INV-39 strips are server-side and untouched.
NET SCORE: 1 − 0 = 1 (the view-as brief bug: YES, it fires for any admin who previews the dept on screen and comes back while the UX-2 trial is admin-only; ST4 itself is a new capability; no new failure mode)

OPERATOR ACTIONS / DEPLOY:
- None.
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` + Deploy → Manage deployments → New version)
- CDR Import / CDR Reporting Tools: no change

FOLLOW-ON ITEMS:
- The driver covers the admin's sequences; a MANAGER walk of the same sequences becomes meaningful only once the gates come off (the manager page has no brief and no switch today) -- extend drive-crossstate then.
- Callbacks for a non-CSR dept are served the CSR-shaped numbers by the mock; the Callbacks-row check is therefore "quotes only after a fetch for the dept on screen", not a numeric comparison.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
