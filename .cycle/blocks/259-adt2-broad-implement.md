---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (ADT-2 is a new capability -- owner request 2026-11-06)
New capabilities (G/ST): ADT-2 -- a summary block on the agent panel's Direct tab, and a ring missed while on another call names who that call was with (owner ruling)
Files modified: apps-script/cdr-import/directCallMetrics.js, apps-script/department-dashboard/AgentDay.gs, apps-script/department-dashboard/script-10-escalations.html, apps-script/department-dashboard/styles.html, tests/unit/direct-call-metrics.test.js, tests/unit/direct-calls-capture.test.js, tools/ui-harness/gen-payloads.js, tools/ui-harness/build-harness.js, tools/ui-harness/drive-agentpanel.js, tools/ui-harness/README.md, docs/operator-state.md (#90), docs/regression-scenarios.md (S56), docs/fix-history.md, docs/per-call-capture.md, docs/next-steps.md, docs/module-dependencies.md, tests/README.md

CHANGES:
ADT-2 | cdr-import/directCallMetrics.js | each occupied interval gets a per-side `w` label from dcBusyWithLabel_ (colleague's roster name; "a queue call"; "an outside number" when they dialed out; "an outside caller"; else "another call" -- never a number, excluded pseudo-agents never named); a missed_busy event carries busyWith from the same busyBlocker the counts use; direct_calls gains busy_with (idempotent ADD COLUMN). Counts unchanged.
ADT-2 | AgentDay.gs | busy_with read through to_jsonb (loads before the cdr-import push); rows carry busyWith (missed_busy only); agentDayDirectSummary_ (pure) over EVERY row, even past the 300-row list cap: in (answered / missed free / missed busy, answer rate when free, avg ring over answered, talk, from colleagues vs outside, outside by DID-2 via), out (to colleagues / outside, connected), colleagues each way sorted by total, busyWith grouped, work vs after hours; payload directSummary (admin-only with the list).
ADT-2 | script-10-escalations.html, styles.html | the summary renders above the Direct list (outside its scroll box); outcome "Missed (on a call with <who>)" / "(on a queue call)" / "(on another call)"; Colleagues top 5 with a focus-keeping "Show all N" toggle.
ADT-2 | harness | gen-payloads builds the Direct tab's rows + summary with the REAL agentDayDirect_; drive-agentpanel asserts the busy names, totals == the rows below, the via split, hours, Show all.

TEST RESULTS: node --test 2847 pass 0 fail (+5 new); lint:gas, module-deps --check (regenerated), INV-16 guard clean; ci:ui all stages pass (drive-agentpanel 44/44); bites 4/4 (busy back in the rate, the label dropped, a number leaking into the label, the summary capped to the list)
REGRESSION RISKS: dates not rebuilt since the cdr-import push read "Missed (on another call)" with no name (expected, not retroactive)
INVARIANTS AT RISK: None (admin-only unchanged; no number stored or shown)
NET SCORE: 0 production fixes − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- Push cdr-import, then run rebuildDirectCallHeldDates() once (Operator State #90) | BLOCKS DEPLOY: N
- Push the dashboard + roll the deployment; walk S56's ADT-2 step | BLOCKS DEPLOY: N
Deploy: CDR Import: cd apps-script/cdr-import && clasp push -f (or scripts/deploy.sh apps-script/cdr-import); Department Dashboard: scripts/deploy.sh .

FOLLOW-ON ITEMS:
- None

DOCUMENTATION UPDATES NEEDED:
- None (done in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
