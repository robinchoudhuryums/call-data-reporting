---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (owner request 2026-11-06, after the DID-0 diagnostic)
New capabilities (G/ST): DID-1 capture stores how each outside direct call arrived; DID-2 Direct Calls report + Team Direct Calls card + CSV split their direct line / a main line; DID-3 the agent panel's Direct tab labels outside callers the same way
Files modified: apps-script/cdr-import/directCallMetrics.js, apps-script/department-dashboard/DirectCallReport.gs, apps-script/department-dashboard/AgentDay.gs, apps-script/department-dashboard/script-9-inbound-direct.html, apps-script/department-dashboard/styles.html, tests/unit/direct-call-metrics.test.js, tests/unit/direct-call-report.test.js, tests/unit/direct-calls-capture.test.js, tests/unit/direct-fallback.test.js, tools/ui-harness/gen-payloads.js, tools/ui-harness/drive-admin.js, CLAUDE.md, docs/operator-state.md (#92), docs/regression-scenarios.md (S70), docs/fix-history.md, docs/per-call-capture.md, docs/invariants.md, docs/conventions.md, docs/known-issues.md, docs/architecture.md, docs/direct-extension-metrics-design.md, docs/module-dependencies.md, docs/next-steps.md, tests/README.md

CHANGES:
DID-1 | cdr-import/directCallMetrics.js | dcDialInAnnotate_ (the DID-0 rule, now shared with dcDialInForDay_): per outside inbound direct call { dialIn digits, via straight/menu/colleague }; {} when the grid stops short of the Departments column (never a guessed menu). buildDirectCallFromRaw_ annotates the events inside a try/catch; direct_calls gains via + dial_in (idempotent ADD COLUMN), written by dcEventTuple_. Not retroactive.
DID-2 | DirectCallReport.gs, script-9-inbound-direct.html, styles.html | directCallViaRows_: its own best-effort read of direct_calls (work window, outside, inbound), class = line only when straight on a number that is not a main line (DIAL_IN_LABELS keys + any number seen with a menu step in 120 days); directCallApplyVia_ folds per (agent, dept) into kpis.via / agent.via / meta.viaAvailable; the sheet fallback carries the same shape with via null; a malformed or failed read leaves the report untouched. Client: summary line "Outside callers: N on their direct line (X% answered) · M from a main line (Y% answered)", per-agent "Outside answered: A their line · B main line" under Answered, the same on the Team Direct Calls card, four CSV columns. directCall:v7.
DID-3 | AgentDay.gs | the Direct tab's outside callers read "Outside caller · their direct line / a main line / via a colleague" (same rule; main lines read only when a row carries via); via + dial_in selected through to_jsonb so the list loads before the cdr-import push.
Plan | docs/next-steps.md | ADT-1 (the panel lists' header row sits mid-table: AC-1's `#dept-page .agents thead th { top: var(--dept-sticky-h) }` reaches the nested tables) and ADT-2 (a Direct tab summary block from the rows already loaded) queued as the next dashboard batch.

TEST RESULTS: node --test 2842 pass 0 fail (+6 new); lint:gas, module-deps --check (regenerated), INV-16 guard clean; ci:ui all stages pass in 240 s (drive-admin's DID-2 assertion included); bites 4/4 (narrow-grid guard, the main-line rule in the panel, the per-(agent, dept) fold, the malformed-read guard)
REGRESSION RISKS: a main line that never shows a menu step and is not in DIAL_IN_LABELS is counted as "their direct line" (Operator State #92 step 3 lists the five known main lines); the via read is one more Neon query per uncached Direct report (small, metered as 'direct')
INVARIANTS AT RISK: None (INV-30 bumped and synced: directCall:v7; INV-01 untouched -- no new write path; admin-only unchanged)
NET SCORE: 0 production fixes − 1 new failure mode (an unlisted straight-routing main line reads as a direct line) = -1

OPERATOR ACTIONS / DEPLOY:
- Push cdr-import, then run rebuildDirectCallHeldDates() once (the held ~14 days gain the split) | BLOCKS DEPLOY: N
- Check DIAL_IN_LABELS lists 19722281820, 18668646332, 18667759594 (PAP Sales), 18083540680, 18883645897 | BLOCKS DEPLOY: N
- Push the dashboard + roll the deployment; walk S70 | BLOCKS DEPLOY: N
Deploy: cd apps-script/cdr-import && clasp push -f (or scripts/deploy.sh apps-script/cdr-import); dashboard: scripts/deploy.sh . (or clasp push -f + Manage deployments → New version)

FOLLOW-ON ITEMS:
- ADT-1 / ADT-2 (queued, docs/next-steps.md).
- The 9 straight calls on 18667759594 to Nathan (Naman) Solanki: check the line's routing in the 8x8 admin (samples 1783985399709, 1783985410115).

DOCUMENTATION UPDATES NEEDED:
- None (done in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
