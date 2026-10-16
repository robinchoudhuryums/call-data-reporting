---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 2" (2026-10-16; not scan findings):
  - 6  Overview trend chart opens with a manager default highlight (Company + own dept; Company only for ALL managers; admins unchanged; no axis zoom on the default) -- which first needed the Company LINE released to managers (owner ruling mid-step: "Release Company line", line only)
  - 1b Agent panel / Agent Day: who was on the other end, as LABELS (staff name, insurer [admin-only for now], "Outside caller · <line>" / "Outside number") + the "↩ callback to HH:MM inbound" cue
New capabilities (G/ST): None (owner-requested features)
Files modified:
  apps-script/department-dashboard/CompanyOverview.gs (personalizeOverview_ companyTrendLine allowlist; ovStripChartTrend_ allowlist)
  apps-script/department-dashboard/script-3-overview.html (ovDefaultPins_, default once per load, no-zoom flag, hover preview, view reads companyTrendLine)
  apps-script/department-dashboard/AgentDay.gs (label reads + pure label/callback helpers + roster memo)
  apps-script/department-dashboard/script-10-escalations.html (From / To columns, callback cue, Agent Day card facts)
  apps-script/department-dashboard/styles.html
  tests/unit/agent-day-labels.test.js (new), tests/unit/overview-chart-answered.test.js, tests/unit/snapshots/ch4-payloads.json (golden: + companyTrendLine on the manager/view-as payloads only)
  tools/ui-harness/build-harness.js, drive-agentpanel.js, drive-smoke.js
  docs: invariants.md (INV-39), client-ui-conventions.md, per-call-capture.md, regression-scenarios.md (S23, S56), module-dependencies.md (regenerated), tests/README.md, CLAUDE.md (Admin-only Overview surfaces: one clause)

CHANGES:
6  | CompanyOverview.gs | Non-admins: companyAggregate still deleted; its two chart series copied BY ALLOWLIST into companyTrendLine. ovStripChartTrend_ keeps company.{trend, trendAbandonedPct} for non-admins (allowlist) instead of deleting company.
6  | script-3-overview.html | ovDefaultPins_ (manager: Company + ovViewerDept_; ALL manager: Company; admin/view-as: none), applied once per page load and never over P28-carried pins; chart._spotlightDefaultPins keeps the natural axis (chartSpotlightFitAxis_), is carried across rebuilds, cleared by chartSpotlightTogglePin_; tile hover previews and restores the default.
1b | AgentDay.gs | Inbound select + dial_in_number/origin_agent/origin_dept; outbound select + (callee_hash IS NULL) AS no_ext, journey. Three extra best-effort reads on the same connection (insurer for inbound / outbound -- ADMIN ONLY; same-day callback matches), each metered, hashes compared in SQL and never selected. Pure helpers agentDayInboundFrom_ / agentDayInternalCallee_ / agentDayOutboundTo_ / agentDayPickCallback_ + agentDayLabelContext_; AGENT_DAY_ROSTER_MEMO_ (one roster read per execution, shared with the entitlement check).
1b | script-10-escalations.html, styles.html | adPartyText_ / adCallbackText_; panel tables gain From / To columns (callback cue under To); Agent Day modal cards gain From / To facts + the cue.

TEST RESULTS: (filled at commit) -- node --test 2548 tests, 2547 pass, 0 fail, 1 skipped before the gate; lint:gas clean; module-deps regenerated and --check clean; INV-16 clean. Two pins caught real defects during the step: cross-file-pins' json_agg(X)-over-a-column-X rule (the callback query aliased a column `t` inside subquery `t`) and OD-3's egress metering -- both fixed before the gate.
REGRESSION RISKS:
  - INV-39 is widened ON PURPOSE (owner ruling 2026-10-16): managers now receive the company RATE and ABANDON% line series. The figures (rung / answered / tiles) stay stripped; both strips are allowlists so a later field cannot leak.
  - Overview: a manager whose metric has no Company line (count metrics) gets their own dept alone; an ALL manager on a count metric gets no default.
  - Agent Day: three extra small Neon reads per day open (metered under 'agentDay'); a failure in any costs only the label.
  - Insurer names stay admin-only in the panel, matching the Inbound report's temporary gate.
INVARIANTS AT RISK: INV-39 (changed by owner ruling; docs/invariants.md updated, pinned by overview-chart-answered + the CH-4 golden). INV-04 (staff names exact-roster only -- pinned). INV-01 untouched (reads only).
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested features)

OPERATOR ACTIONS / DEPLOY:
- Optional: set DIAL_IN_LABELS (Operator State #33) so outside callers show the line name | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- When the Inbound report is released to managers, pass { insurer: true } for them in getAgentDay (one line, AgentDay.gs) so the panel shows insurer names too.
- The Individual Report's monthly count views still have the partial-month shape (from Step 1).
- Plan Steps 3-5 remain (accordion + inbound/outbound together + preloading; day bars B; notifications/coaching/alerts, all admin-only).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
