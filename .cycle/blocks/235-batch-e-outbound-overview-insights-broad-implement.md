---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- E2  outbound line on the Overview dept tiles (placed / connected / connect % for the selected card window), computed inside the cached Overview blob; admin-only while the 6c gate stands
- E1  Outbound fold in the Insights region (current window vs prior window, five tiles with deltas, per-agent table, the dept's OWN group); admin-only through the same client gate as Batch D
Files modified: apps-script/department-dashboard/CompanyOverview.gs, script-3-overview.html, script-8-insights.html, dashboard.html, styles.html, OrphanFix.gs + DeptConfig.gs (version refs only); tests/unit/overview-outbound.test.js (new), tests/unit/cross-file-pins.test.js; tools/ui-harness/drive-outbound-e.js (new), gen-payloads.js, build-harness.js, ci.mjs, drive-deptoutbound.js, drive-agentpanel.js; CLAUDE.md, tests/README.md, docs/invariants.md (INV-30 v27, INV-39), docs/client-ui-conventions.md, docs/per-call-capture.md, docs/operator-state.md (#63), docs/regression-scenarios.md (S58), docs/architecture.md, docs/known-issues.md + docs/conventions.md (version tables), docs/module-dependencies.md

CHANGES:
E2 | CompanyOverview.gs | `ovReadOutboundByDept_` makes ONE grouped Neon read of outbound_calls over the existing read window: per agent, placed and connected for each of the five card periods, using the same starts as the inbound stats. `ovOutboundShape_` attributes through the same `deptsForAgent` roster map and flags `partial` when a period predates capture. Tiles gain `outbound`, and the blob gains `outboundCoverageStart`. Both are present ONLY when the read succeeded, so a Neon-less payload is byte-identical (the CH-4 goldens are unchanged). The read is metered as `overviewOutbound`. `personalizeOverview_` strips both fields for every non-admin while OUTBOUND_VETTING_GATE_ stands, and fails closed when OutboundReport.gs is absent. Cache key is now companyOverview:v27.
E2 | script-3-overview.html, styles.html | `ovBuildOutboundLine_` adds a violet "Outbound" pill line on the grid tiles and expanded sub-queue cards for the current card window, with "since <capture start>" on a pre-capture window. It renders only when the server shipped the field.
E1 | dashboard.html, script-8-insights.html, styles.html | `#ins-ob-fold` (data-admin-only + display:none) sits after Queue health.
  - `insObSync_` shows it only while `obAllowed_()`. It fetches `getDeptOutboundSummary` for the region's window and its prior window (not on the SWR pre-paint), guards stale responses with a token, and repaints a repeat render of the same windows from the last result.
  - `insObOwnScope_` keeps the dept's own deptGroups subtotal and agents, because Insights covers one department per run.
  - The fold shows five tiles with `insDeltaBadge_` deltas (per day on mismatched lengths) and a per-agent table inside a horizontal scroller.
  - No comparison is shown when the prior window predates capture; notes cover the sheet fallback and off-roster callers.
  - Fold state persists as `ob` (open by default).
E1/E2 | cross-file-pins.test.js | the 6c pin now also moves `#ins-ob-fold` with the report, requires the fold's obAllowed_ gate, and requires the Overview strip to read the gate.
harness | gen-payloads.js, build-harness.js, drive-outbound-e.js, ci.mjs | The tiles' line is produced by the REAL Overview read through a fake conn that answers only that SQL. The Insights fold's prior and single-day windows are captured from the real getDeptOutboundSummary. The mock serves View-as the manager capture, matching the server. New stage drive-outbound-e.js has 18 checks.
harness fix | drive-deptoutbound.js, drive-agentpanel.js | Two vacuous checks I wrote in Batches B and D are fixed:
  - "no unmocked calls" read `window.__UNMOCKED__`, which the harness never sets; it now reads `__HARNESS__.unmocked`, minus drive-smoke's UNMOCKED_OK getInboundHeatmap.
  - The call-name filter used `c.name`, but calls are recorded as `{fn, args}`.

TEST RESULTS: passed.
- npm run ci: 2234/2234, 1 skipped (as before), INV-16 in sync, module-deps up to date.
- npm run lint:gas: clean.
- CI=1 npm run ci:ui: all stages passed (drive-outbound-e 18/18).
- The 360 px checks in drive-deptoutbound and drive-agentpanel first FAILED on the new fold's table (page 510 px wide). That was caused by this batch and fixed with `.ins-ob-scroll`.
- Bites: the fold markup pin, the fold gate pin and the Overview strip pin each BITE. The driver BITES: the YTD check fails when the line ignores the card window.

REGRESSION RISKS:
- The Overview now opens a Neon connection on every cache-miss recompute, even when DQE_READ_SOURCE and QCD_READ_SOURCE are both `sheet`. A fast failure is absorbed by the per-execution down-memo. A HANGING connect (the open #70 class) can now stall a cold Overview recompute in an install that never touched Neon from the Overview before. It happens on cache miss only, and CacheWarm keeps the blob warm.
- The cached blob grows by about 4-5 KB at 14 depts, to roughly 32 KB of the ~100 KB cap. The F6 tripwire still logs it.
- A failed outbound read still caches the blob without the line, so an admin can miss the line until the freshness tag moves or the 6h TTL ends. This is deliberate: the alternative turns a Neon outage into an uncached Overview for every viewer.
- The Insights fold adds two cached RPCs per admin Insights render.
INVARIANTS AT RISK: None.
- INV-39: the strip list grew; it is pinned in overview-outbound.test.js and the 6c pin.
- INV-30: bumped to companyOverview:v27; cache-version-sync passes.
- INV-26: these are dept totals, so the exclusions correctly do not apply.
- INV-53: roster attribution only.
- OD-3: metered, with the label `overviewOutbound`.
NET SCORE: 0 production fixes − 1 new failure mode (the Overview's new Neon connect on a cold recompute) = −1. This is a feature batch; the two driver fixes are gate-correctness, not production.

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (Batches A-E together) and walk S56, S57, S58 as the admin | BLOCKS DEPLOY: N
- After deploy, check that the Overview still loads quickly on a cold cache. The first admin load after the morning ingest pays the new outbound read. | BLOCKS DEPLOY: N
- 6c release later (Operator State #63): `#ins-ob-fold` now moves with the gate. The Overview line needs no edit. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- drive-journey.js has the same vacuous `__UNMOCKED__` check (pre-existing, not mine); queued as a suggested task.
- No prior-period chip on the tiles' outbound line, and no outbound in the Insights emails / CSV / saved views.
- If the cold-recompute Neon connect proves costly, move the outbound block to its own admin-only cache key (the getOverviewChartTrend precedent). Managers would then never trigger the read while gated.
- Carried from D: no prior-period chips on the outbound columns, no Yesterday/MTD toggle on Team Outbound, no outbound CSV export.

DOCUMENTATION UPDATES NEEDED: None (done in this batch: CLAUDE.md stage text + S58 index, tests/README.md, INV-30/INV-39, client-ui-conventions, per-call-capture, operator-state #63, regression-scenarios S58, architecture, version tables, module-dependencies).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
