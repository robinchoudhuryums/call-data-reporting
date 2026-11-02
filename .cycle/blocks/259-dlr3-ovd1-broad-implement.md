---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (owner asks 2026-11-02, both from approved mocks)
- DL-R3: Direct lines (Overview + Insights) laid out like the Agent Call Metrics table; work vs after hours side by side; per-department hours split
- OVD-1: Overview dept tile split bar shows the direct-line answer rate (outbound stays as text), admin-only
(CBX-1, earlier the same day, is commit 197f976 -- CSR and Spanish out of the company callback figures.)
New capabilities (G/ST): DL-R3's All / Work / After hours switch on the department table; OVD-1's per-tile direct-line answer rate with a prior-window chip
Files modified:
- apps-script/department-dashboard/OutboundReport.gs
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/department-dashboard/OrphanFix.gs (comment)
- apps-script/department-dashboard/script-9-inbound-direct.html
- apps-script/department-dashboard/script-3-overview.html
- apps-script/department-dashboard/styles.html
- tests/unit/overview-direct.test.js (new), tests/unit/overview-outbound.test.js, tests/unit/outbound-episodes.test.js, tests/README.md
- tools/ui-harness/build-harness.js, gen-payloads.js, drive-callbacks.js, drive-cbdept.js, drive-outbound-e.js
- docs: invariants.md (INV-30), conventions.md, architecture.md, per-call-capture.md, known-issues.md, client-ui-conventions.md, regression-scenarios.md (S58, S60), fix-history.md, module-dependencies.md

CHANGES:
DL-R3 | OutboundReport.gs | `obDirectRowFigures_(eps, isAfter)` adds `work` / `after` sub-figures to every byDept row and person; `outboundDirect:v5`
DL-R3 | script-9-inbound-direct.html | `outboundDirectSummaryHtml_` is a work / after / all table (`.ob-dl-cmp`, `obDlBarCellHtml_`, `obDlRateCellsHtml_`, one legend `obDlKeysHtml_`); `obDlTableHtml_(data, hours)` uses the same cells, bar length = callers; `obDlSetHours_` swaps row cells in place (open rows stay open, footer full width); the retired "work · after" legend and `.ob-dl-group` styles are gone
DL-R3 | styles.html | `.ob-dl-cmp` family; `.ins-brief-list > .ins-brief-item { min-width: 0 }` so the wider table cannot grow the brief row under the sticky side panels
OVD-1 | CompanyOverview.gs | `ovDirectSql_` / `ovDirectShape_` / `ovReadDirectByDept_` (direct_call_history by department, five card periods + INV-28 priors, rate = answered / (answered + missed while free)); `ovReadTileLines_` runs it and the outbound read on ONE connection, each failing alone; tile `direct` + blob `directCoverageStart` / `directThrough` / `directPriorWindows`, stripped for every non-admin; `companyOverview:v30`
OVD-1 | script-3-overview.html | `ovBuildOutboundLine_` = `ovBuildObRow_` (outbound text + chips) + `ovBuildDirectLine_` (pill, rate + `obRateChip_`, answered / missed / busy bar, counts in words); the outbound connected bar is drawn only when the tile has no direct block

TEST RESULTS: node --test 2810 pass / 0 fail (TZ=America/Chicago); lint:gas clean; module-deps --check clean after --write; INV-16 guard clean; bites 5/5 (DL-R3 split, OVD-1 strip, busy out of the rate, outbound bar gives way, and -- by hand, ci:ui driver -- the brief min-width fix); ci:ui: see STATE (run ciui-dlr3)
REGRESSION RISKS:
- The Overview now runs a second Neon statement per compute (same connection). It is cached in the blob, so the 5-minute auto-refresh never reaches Neon.
- An Overview tile whose direct read fails falls back to the old outbound connected bar, so no tile loses a bar.
INVARIANTS AT RISK: INV-30 (two bumps, both recorded); INV-39 (a new admin-only Overview field joins the strip, unconditional); INV-28 (prior windows via the shared computePriorWindow_) -- none violated
NET SCORE: 0 production fixes − 0 new failure modes = 0 (owner-requested capabilities; the min-width fix is a latent-layout fix exposed by the wider table, not a production bug)

OPERATOR ACTIONS / DEPLOY:
- None new | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Manage deployments → New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- The tile's direct-line figures (and the outbound line's) do not apply #81 exception days, matching the Direct Calls report; phase 2 of #81 would cover all three together.
- Direct-line rates are admin-only with no release switch; when the Direct Calls report is released to managers, release the tile row with it (one strip in personalizeOverview_).

DOCUMENTATION UPDATES NEEDED:
- None (done in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
