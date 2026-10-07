---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch D (owner plan 2026-10-06), all admin-only until the 6c release:
  - D1: server outbound summary per agent;
  - D2: Inbound | Outbound | Both switch on the My Department agent table;
  - D3: Team Outbound side panel;
  - D4: shared gate with the Outbound report, plus tests and a UI driver.
Files modified: apps-script/department-dashboard/OutboundReport.gs, dashboard.html, script-5-dept.html, script-10-escalations.html, styles.html; tests/unit/outbound-fallback.test.js, tests/unit/cross-file-pins.test.js, tests/unit/cache-version-sync.test.js, tests/unit/client-dead-ends.test.js; tools/ui-harness/gen-payloads.js, build-harness.js, ci.mjs, drive-deptoutbound.js (new); CLAUDE.md, docs/operator-state.md, docs/per-call-capture.md, docs/invariants.md, docs/client-ui-conventions.md, docs/regression-scenarios.md, docs/module-dependencies.md, tests/README.md

CHANGES:
D1 | OutboundReport.gs | getDeptOutboundSummary({department, from, to}) is the Outbound report's per-agent half without the callback queries.
  - Shared with the report: the per-agent SQL (outboundAgentsSel_, hoisted out of computeOutboundReport_) and the sheet aggregation (obAgentsFromGrid_, hoisted out of obBuildBlobFromGrids_), so the two cannot disagree.
  - Both paths gained ob_days (distinct call dates). The shaper adds obDays and obPerDay.
  - Uses outboundShapeReport_ (roster attribution, PC-12 grouping, off-roster disclosure) and outboundResolveRequest_ (the 6c gate). The SEC-1 cap is pinned.
  - Cache prefix deptOutbound:v1:, carrying the freshness tag and a roster hash. Fallback and unavailable payloads are not cached.
  - deptObTotals_ computes team per-day with the team-average excludes left out; totals keep them (R18).
  - deptGroups are returned for a parent dept.
  - Neon read labelled 'deptOutbound'.
D2 | dashboard.html, script-5-dept.html, styles.html, script-10 |
  - The #dept-dir-switch is admin-only (data-admin-only + display:none) and moves with #outbound-report-btn under the extended 6c pin.
  - Client permission is the switch's own visibility (obAllowed_), so view-as-manager and real managers fall back to Inbound.
  - Outbound and Both render a separate #agents-ob-table (obViewRender_), so the inbound COLUMNS model, its sort and its exports are untouched. A note states that Export/Copy stay inbound.
  - Outbound view: violet connected / not-connected tally, placed total, "N / day", Connect %, talk, avg talk, attempts, sortable headers, per-dept groups and subtotals, Total row.
  - Both view: inbound bar + Answer % beside outbound bar + Connect % + talk, one row per agent, never summed.
  - body[data-dir] drives visibility in CSS.
  - The choice persists in cdr.dept.direction.
  - Rows open the Batch B inline panel (apTbody_ follows the visible table).
  - Also fixed: the table hint still said a row click opens the Individual Report (stale since Batch B).
D3 | dashboard.html, script-5, styles | #dept-team-outbound panel: tiles (Placed, Connect %) and a per-agent mini table with tallies, grouped per dept, rows jump to the agent's row. It replaces Team Rings in the Outbound view and stacks under it in Both; there both panels take natural height with capped tables, so they no longer overlap.
D4 | tests + harness + docs |
  - outbound-fallback.test.js gained 7 tests: view equals report agent-for-agent; Neon and sheet paths agree with obDays; the fallback is never cached; the cache key; the gate; team per-day excludes; per-dept groups; the shared-SQL and ob_days source pins.
  - cross-file-pins: the 6c pin now covers the switch and the shared gate; getDeptOutboundSummary joined the SEC-1 list.
  - cache-version-sync SPECS/ANCHOR_SPECS gained deptOutbound.
  - client-dead-ends UD-6 hint count raised 2 -> 3 for the new panel.
  - gen-payloads produces dept-outbound-30d from the REAL getDeptOutboundSummary; build-harness mock added.
  - New asserting stage drive-deptoutbound.js (23 checks).
  - Docs: Operator State #63 release step, per-call-capture, INV-30, client-ui-conventions, S57, tests/README, CLAUDE.md gate block (TEN stages) + S57 index, module-deps.

TEST RESULTS: passed.
  - npm run ci: 2226/2226 (+1 source pin added after a bite miss), INV-16 in sync, module-deps up to date.
  - lint:gas: clean.
  - ci:ui under CI=1: all ten stages green (smoke 150, f13 22, subqueue 38, journey 14, agentpanel 22, deptoutbound 23, admin 125, devoverlay 14, agent 26).
  - Bite checks: six bite (ob_days SQL, fallback-uncached, team excludes, same gate, switch hidden, and the driver's Team Rings hide).
    - The first ob_days bite did NOT bite: the mocked connection never runs SQL. A source pin was added and then bit.
  - Fixed during the run (caused by this session):
    - the UD-6 count pin, updated for the new panel's hint;
    - the side-panel overlap in Both, found by screenshot before the driver existed;
    - the driver's tour-skip ordering.
REGRESSION RISKS:
  - The Outbound report's payload gains obDays/obPerDay per agent. This is additive, the client ignores it, and there is no cache bump, so up to 6 h of older blobs lack it harmlessly.
  - The report's agentsSel and agentsFor are now thin wrappers over the hoisted helpers, with identical SQL text plus one column. The report's 184 suite tests and the parity test pass.
  - The side column in Both can now need its own scrollbar (the documented R18b last resort).
  - The inbound table, its exports and Team Rings are unchanged in the Inbound view (drivers confirm).
INVARIANTS AT RISK: None.
  - INV-01: read-only RPC.
  - INV-04: exact roster attribution via the shared shaper.
  - INV-30: new prefix registered.
  - INV-36: roster hash via hashAgents_.
  - INV-39: no Overview change.
  - INV-53: dept views list roster agents only.
  - 6c gate shared and pinned.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (feature work, owner-requested)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (Batches A-D together) and walk S56 and S57 as the admin | BLOCKS DEPLOY: N
- Manager release of D (and of E later) happens only with 6c (Operator State #63 step 4 now names the switch) | BLOCKS DEPLOY: N
- Batch C probe (Operator State #74) still worth running: it no longer gates D's source, since talk/connect need Neon regardless, but a CLEAN result would let a later batch move PLACED counts to the sheet | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- No prior-period delta chips on the outbound columns. The inbound table has them; the report has agentsPrior, which could be carried over.
- No period toggle (Yesterday/MTD) on Team Outbound. It follows the page's dates only.
- Export/Copy in the Outbound/Both views still produce the inbound table. A dedicated outbound CSV would need its own csvSafeCell_-routed writer (pinned list).
- The fixture has no outbound-only agent, so the Both view's outbound-only row path is exercised in code but not in the driver.
- Batch E: Outbound in Insights and on the Overview tiles (admin-only).

DOCUMENTATION UPDATES NEEDED:
- None beyond those made in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
