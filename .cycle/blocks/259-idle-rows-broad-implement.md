---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner round 2026-10-20 (IDLE-1, not scan findings), from a Power combined-view screenshot:
  - 1  drop all-zero agent rows from the My Department table (server, opt-in), naming them under rosterWithNoData
  - 2  bump summary:v23 -> v24
  - 3  outbound-only agents stay visible (they come from the outbound join, not the inbound rows) -- verified, no code needed
  - 4  a zero row in the bar cell draws a muted dash, not an empty full-width gray track
  - 5  unit tests for both zero-row writers + the bar cell; docs
New capabilities (G/ST): None
Files modified:
  apps-script/department-dashboard/Data.gs (computeSummary_ opts.dropIdle; getDepartmentSummary passes it on every part + the subs-scope primary; cache key summary:v24)
  apps-script/department-dashboard/script-1-core.html (answeredBarHtml_: `.ans-idle` dash when a row has no calls; the dead zero-width classic branch removed)
  apps-script/department-dashboard/styles.html (.ans-idle; .ans-seg.none kept -- escalations still uses it)
  apps-script/department-dashboard/OrphanFix.gs (comment: summary:v24)
  tests/unit/compute-summary.test.js (+2), tests/unit/answered-bar.test.js (new, 2), tests/unit/day-bars.test.js (source pin follows the call), tests/README.md
  docs: invariants.md (INV-30 v24), fix-history.md (IDLE-1), client-ui-conventions.md, and the summary:v24 mentions in CLAUDE.md, operator-state.md, known-issues.md, conventions.md, architecture.md; module-dependencies.md regenerated

CHANGES:
1 | Data.gs | computeSummary_(..., { dropIdle: true }) skips an agent whose window total of rung, answered, missed, unique and talk is all zero, and keeps them out of agentsWithData so they land in diagnostics.rosterWithNoData. Only getDepartmentSummary passes it; the agent app, digests, coaching, diagnostics and the smoke check keep the row.
2 | Data.gs + docs | summary:v24 so a cached table with idle rows is not served after deploy; INV-30 records why.
3 | (none) | Outbound-only agents enter the inbound+outbound table from the outbound payload (script-5-dept, inb: null), so dropping the zero inbound row leaves them listed.
4 | script-1-core.html, styles.html | `if (!total)` renders `<div class="ans-idle">` + zeroCell_('–') for agent and totals rows alike; rows with calls unchanged.
5 | tests, docs | both writers pinned: a build-written zero row (incl. a prior-window agent and a stamped Avg Abd Wait) and a queue-split crossover narrowed to zero (QUEUE_SPLIT_SCOPE=dept, kept in the other dept).

TEST RESULTS: passed -- node --test 2609 tests, 2608 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 clean; module-deps regenerated; 5/6 bites land (the miss is the subs-scope primary, a scope the client never sends -- it only feeds diagnostics there); ci:ui result recorded in the commit.
REGRESSION RISKS:
  - An agent with calls only in the PRIOR window, or none at all, no longer shows a row -- their prior-period chips go with them (owner ruling; already the rule for prior-only agents).
  - Totals: no count or sum moves. The Avg Abd Wait / CSR Avg Abd Wait means lose the idle agents' per-day stamp (a weighting change on a per-day constant, not a value change).
  - meta.agentsWithData counts only shown rows; rowsMatched still counts every matched row.
INVARIANTS AT RISK: INV-30 (version bumped, documented). INV-53 / INV-05 untouched (totals and means already skipped zeros). INV-39 n/a.
NET SCORE: 1 production fix (fired this month: the screenshot) - 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- The CSV / TSV export follows the table, so it no longer lists idle agents -- expected, noted for anyone comparing an old export.
- The screenshot implies QUEUE_SPLIT_SCOPE=dept is on in production (a crossover agent shows different figures per dept); confirm in the Health inventory if that is a surprise.

DOCUMENTATION UPDATES NEEDED:
- None beyond those in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
