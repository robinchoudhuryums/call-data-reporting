---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F1  prior-period chips on the Overview tiles' outbound line: Placed (up = good, muted under 3 calls) and connect rate in points (muted under 2 pts or when either window placed < 10 calls), vs each card period's INV-28 prior window; no chip when that window starts before outbound capture
- F2  prior-period chips on the My Department Outbound / Both rows: Connected (valenced), Not connected (always neutral), Connect % (same rate rule), vs the summary's own INV-28 prior window; none on Total/subtotal rows, none for an agent with no prior row, none before capture
Files modified: apps-script/department-dashboard/CompanyOverview.gs, script-5-dept.html, script-3-overview.html, OrphanFix.gs + DeptConfig.gs (version refs); tests/unit/overview-outbound.test.js; tools/ui-harness/gen-payloads.js, drive-outbound-e.js, drive-deptoutbound.js; CLAUDE.md (driver text), tests/README.md, docs/invariants.md (INV-30 v28, INV-39), docs/client-ui-conventions.md, docs/per-call-capture.md, docs/regression-scenarios.md (S58 steps), docs/known-issues.md + docs/conventions.md + docs/architecture.md + docs/operator-state.md (version refs), docs/module-dependencies.md (regenerated: CompanyOverview -> Data.gs edge)

CHANGES:
F1 | CompanyOverview.gs | `ovOutboundPriorWindows_` resolves each card period's prior window through the shared `computePriorWindow_` (INV-28; empty when Data.gs is absent). `ovOutboundSql_` adds `pp_<k>` / `pc_<k>` FILTER columns in the SAME grouped statement and widens the lower bound to the earliest prior start. `ovOutboundShape_` attributes prior counts through the same roster map and sets `prior` per period, which is null unless the window starts on or after `coverageStart`. The blob gains `outboundPriorWindows`, and `personalizeOverview_` strips it with the line. Cache key is now companyOverview:v28.
F1 | script-3-overview.html | `ovBuildOutboundLine_` adds chips after Placed and after the connect %. The hover text names the prior window and its figures.
F2 | script-5-dept.html | `obPriorChip_` / `obRateChip_` / `obPriorTip_` are one shared helper set (wow-chip dialect; OB_CHIP_RATE_PTS_ = 2, OB_CHIP_MIN_PLACED_ = 10).
  - `obViewSync_` fetches the prior window (`state.meta.priorFrom/priorTo`) through a second cached `getDeptOutboundSummary` call; the key includes the prior window.
  - `obViewRender_` matches prior agents by dept + agent. `obBarHtml_` / `obPctHtml_` take an optional prior, and totals calls pass none.
  - Row entries now carry `dept`.
tests | overview-outbound.test.js | One E2 pin updated (the period block now carries `prior`). Five F tests added:
  - prior windows equal computePriorWindow_, counted in one statement with the widened bound;
  - prior attribution and the coverage-null rule;
  - strip/ship of `outboundPriorWindows`;
  - the client chip RUN in a vm (valence, noise, the thin-window rate rule, the neutral not-connected chip);
  - wiring (tiles, rows, totals never, the INV-28 window).
harness | gen-payloads.js, drive-outbound-e.js, drive-deptoutbound.js | The fake Overview read carries prior counts. New driver checks:
  - the tile chips match payload deltas, and YTD has no chips;
  - every agent row has 3 chips, the not-connected chip is neutral, the connected delta matches the prior payload, and totals have none;
  - Both rows carry them too.

TEST RESULTS: passed.
- npm run ci: 2239 pass / 0 fail, INV-16 in sync, module-deps up to date after the regeneration.
- lint:gas: clean.
- CI=1 npm run ci:ui: all stages passed (drive-deptoutbound 29/29, drive-outbound-e 20/20).
- Bites: the coverage rule, the thin-window mute, the neutral not-connected valence and the outboundPriorWindows strip each BITE. drive-deptoutbound bites when the prior lookup is disabled (4 checks fail).

REGRESSION RISKS:
- The Overview's outbound read now reaches back to the earliest prior window. YTD's prior is last year's same-length tail, so once capture passes a year that read aggregates about two years of outbound_calls on each cold recompute. It is still one statement and only on cache miss; today it is bounded by capture start (2026-07-10).
- The Outbound view issues a second RPC (the prior window). It is cached server-side like the first; a failed prior read just shows no chips.
- Both-view rows are a little wider. Verified no 360 px overflow (driver checks).
INVARIANTS AT RISK: None.
- INV-28: both surfaces use computePriorWindow_ (server-side for the tiles, the summary's server-resolved window for the table).
- INV-30: bumped to v28, synced.
- INV-39: the new field is stripped; tested.
- OD-3: the same metered read.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature batch; the wider prior read is a cost, documented above, not a failure mode)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (Batches A-F) and walk S56, S57, S58 (S58 now has the chip steps) as the admin | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- The Insights Outbound fold keeps its own insDeltaBadge_ percent deltas rather than these chips. It is a different dialect, but that matches the rest of Insights.
- drive-journey.js vacuous unmocked check (pre-existing; suggested task already queued).
- If the two-year YTD-prior read ever shows up on the egress gauge, restrict the prior columns to periods whose prior window could overlap capture.

DOCUMENTATION UPDATES NEEDED: None (done: client-ui-conventions Batch F bullet, per-call-capture paragraph, S58 steps, INV-30/INV-39, tests/README, CLAUDE.md driver text, version tables, module-dependencies).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
