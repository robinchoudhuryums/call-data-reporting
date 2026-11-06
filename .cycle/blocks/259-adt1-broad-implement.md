---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: ADT-1 -- the agent panel's call lists showed their header row partway down the rows
New capabilities (G/ST): None
Files modified: apps-script/department-dashboard/styles.html, tests/unit/cross-file-pins.test.js, tools/ui-harness/drive-agentpanel.js, tools/ui-harness/README.md, docs/client-ui-conventions.md, docs/regression-scenarios.md (S56 step), docs/fix-history.md, docs/next-steps.md (ADT-1 done; ADT-2 busy-with ruling)

CHANGES:
ADT-1 | styles.html | AC-1's page-sticky header offset now uses child combinators (`#dept-page .agents > thead > tr > th`), so it reaches only the outer agent table's header; the panel's nested lists keep the base sticky `top: 0` inside their own scroll box. The Inbound and Outbound lists had the same fault as the Direct list.
ADT-1 | cross-file-pins.test.js, drive-agentpanel.js | source pin: the scoped selector exists and no descendant `.agents thead th { top: var(--dept-sticky-h` remains; driver: the Inbound and Direct lists' header top equals the list top (failed at offset 77 before the fix, 0 after).

TEST RESULTS: node --test 2843 pass 0 fail; lint:gas, module-deps --check, INV-16 guard clean; ci:ui all stages pass (drive-agentpanel 40/40, drive-deptoutbound's AC-1 sticky check still passes); bite 1/1 (the descendant selector restored)
REGRESSION RISKS: None -- the outer tables' thead is an explicit child of each table, so AC-1 is unchanged (drive-deptoutbound AC-1 PASS)
INVARIANTS AT RISK: None
NET SCORE: 1 production fix − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- Push the dashboard + roll the deployment; S56's ADT-1 step | BLOCKS DEPLOY: N
Deploy: Department Dashboard: scripts/deploy.sh . (or clasp push -f + Manage deployments → New version)

FOLLOW-ON ITEMS:
- ADT-2 (queued): the Direct tab summary block; owner ruled (2026-11-06) a "missed while on another call" names who that other call was with -- needs a cdr-import busy-with field on direct_calls.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
