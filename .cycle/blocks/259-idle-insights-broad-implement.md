---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner round 2026-10-20 (IDLE-2, the Insights twin of IDLE-1; not scan findings):
  - IDLE-2  an agent-free Insights run (the region on My Department, and its email) drops every agent with no calls in the current window
New capabilities (G/ST): None
Files modified:
  apps-script/department-dashboard/InsightsReport.gs (computeInsights_ opts.dropIdle; getInsightsReport + sendInsightsReportEmail pass it when no agents were picked; insights:v26)
  apps-script/department-dashboard/CacheWarm.gs (comment: insights:v26)
  tests/unit/insights-report.test.js (+2), tests/README.md
  docs: invariants.md (INV-30 v26), fix-history.md (IDLE-2), client-ui-conventions.md, architecture.md, known-issues.md, conventions.md; module-dependencies.md regenerated

CHANGES:
IDLE-2 | InsightsReport.gs | On an agent-free run the per-agent cards skip any agent whose current-window rung, missed, answered and talk are all zero: an ex-employee on the roster, or (QUEUE_SPLIT_SCOPE=dept) an agent on two rosters who worked only the other dept's queues. The one active only in the prior window had a full 0 / 0 / 0 "Slipping" card. An explicit pick keeps its card; the team rollup, team average, charts, brief counts and the Digest / smoke-check callers are unchanged.

TEST RESULTS: passed -- node --test 2611 tests, 2610 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps regenerated; 5/5 bites land; ci:ui result recorded in the commit.
REGRESSION RISKS:
  - The quiet-agents fold and the small-sample banner no longer count idle agents (intended: the banner fired falsely when ex-employees diluted the average).
  - The Insights CSV / email no longer list idle agents on a whole-dept run.
INVARIANTS AT RISK: INV-30 (bumped, documented). INV-27 / INV-26 / INV-53 untouched (the team figures already used active roster agents only).
NET SCORE: 1 production fix (fires today with the split on) - 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- None

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
