---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- CB-R1 -- Overview "Callbacks by department" + the Insights Callbacks fold: one summary leads with the callers NOBODY called back, then one bar of five outcomes on ONE base (own team / another team / got through / still pending / not called back) with a legend; the no-queue hang-ups and unmapped queues move under "How this is counted".
- CB-R2 -- the department table sorts most-not-called-back first, shows "n · pct%" after Contact episodes, and each row lists ITS unreturned callers on demand.
- DL-R2 -- Direct lines (Overview + Insights): the unreturned count first, a work-hours and an after-hours bar on one base, a department -> person table, and a person -> the callers who tried their line first with no callback.
New capabilities (G/ST):
- DL-R1 -- `getOutboundDirectCallbacks` adds `byDept` (department, then line owner tried first) and `after.medianFromOpenSec` (after-hours callback time from the next work-window open); `getOutboundDirectRepeats` takes `owner` + `minAttempts:1`. Cache `outboundDirect:v4`.
Files modified: apps-script/department-dashboard/{OutboundReport.gs, script-3-overview.html, script-8-insights.html, script-9-inbound-direct.html, dashboard.html, styles.html}; tools/ui-harness/{build-harness.js, drive-callbacks.js, drive-cbdept.js, README.md}; tests/unit/{outbound-episodes.test.js, outbound-report.test.js}; tests/README.md; docs/{invariants.md, conventions.md, architecture.md, per-call-capture.md, client-ui-conventions.md, fix-history.md, regression-scenarios.md, module-dependencies.md}

CHANGES:
CB-R1 | script-9 / script-3 / script-8 / dashboard.html / styles.html | `outboundCallbackTilesHtml_` replaced by `obOutcomeBarHtml_` + `obOutcomeLegendHtml_` inside `outboundCallbackSummaryHtml_`; Overview header "N of M callers not called back · P% called back by their own team"; `#ov-cbdept-notcounted` in a closed `.ob-howto`. New bar class is `.ob-obar` (`.ob-bar` is already the My Department agent-table bar -- the first name collided and broke drive-deptoutbound's alignment check; renamed).
CB-R2 | script-9 | `OB_CBDEPT_DEFAULT_SORT_ = none desc`; the none column moves after episodes; `.ob-cbdept-uncalled-btn` per row -> `outboundLoadUncalledInto_` scoped to the row dept + section window, per-BUTTON sequence.
DL-R1 | OutboundReport.gs | pure `obNextWorkOpenOrd_`, `obDirectMedianFromOpen_`, `obDirectEpOwner_`, `obDirectRowFigures_`, `obDirectByDept_`; repeats owner/minAttempts filter; v4 prefix (INV-30 + conventions table updated).
DL-R2 | script-9 / dashboard.html / styles.html | `outboundDirectSummaryHtml_`, `obDlTableHtml_` + delegated `obDlWireTable_` (dept toggle, person drill via `getOutboundDirectRepeats({owner, minAttempts:1})`).

TEST RESULTS: node --test 2729 pass / 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean; module-deps regenerated. Rendered gate: `CI=true npm run ci:ui` exit 0, no FAIL in any stage (drive-cbdept 23/23, drive-callbacks 43/43, drive-deptoutbound 45/45). Bites: 6/6 unit (next-open holidays, median from open, first-tried owner, no-team row last, owner filter, minAttempts clamp) + 3/3 UI (bar drops a segment, default sort key -- bit only after adding an aria-sort pin, uncalled list loses its dept).
REGRESSION RISKS: the CSV and the table columns' meaning are unchanged (only the order and the none cell's text); the Insights fold and the Overview share the renderers, so both changed together on purpose. The after-hours median from the open differs from the earlier "from the call" figure by design (both are in the payload).
INVARIANTS AT RISK: INV-30 (outboundDirect bumped to v4, docs + cache-version-sync updated). INV-39 / the 6c gate: unchanged, every surface still admin-only.
NET SCORE: 2 - 0 = 2 (CB-R1 + DL-R2 fixed figures that did not add up for the owner this month; DL-R1 is a new capability; CB-R2 counts with CB-R1).

OPERATOR ACTIONS / DEPLOY:
- None beyond the deploy | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- Release the per-person rows to managers (own department) after vetting -- owner ruling 2026-10-28.
- HOH-1 / XB-1 wait on the owner's diagnostic logs.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change: fix-history CB-R1/CB-R2/DL-R1/DL-R2, client-ui-conventions "Callback summaries", per-call-capture, S48/S60, tests/README, harness README).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
