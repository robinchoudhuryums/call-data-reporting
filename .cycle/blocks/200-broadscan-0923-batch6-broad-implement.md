---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- PCR-1: a parent dept's inbound scope (Inbound / Outbound reports, journey drill, Missed-section sentinels) now rolls in its children's raw inbound-queue aliases, not only their canonical queues.
- PCR-2: the answered-on-hold arm now claims the children's final-dept labels too, from ONE helper shared by the SQL predicate and both sheet-fallback mirrors.
- SEC-7: the inbound journey sheet fallback no longer returns miss reasons before auth (an existence oracle) and no longer discloses an insurer label the Neon path never carries.
- PCR-3: outbound `pendingTail` is inclusive of the last callback-window day and anchored on the script-TZ date instead of Neon's UTC `current_date`.
- PCR-9: the outbound vetting run FAILS when the outbound leg was served from the sheet copy.
- PCR-5: the agent-day inbound pre-filter matches the name as a quoted JSON value (LIKE wildcards escaped), and a LIMIT hit always flags truncation.
- PCR-8: every committed escalation write force-refreshes the outage snapshot, not only delete.
Files modified:
- apps-script/department-dashboard/InboundReport.gs
- apps-script/department-dashboard/OutboundReport.gs
- apps-script/department-dashboard/MissedCallsReport.gs (cache version + comments)
- apps-script/department-dashboard/AgentDay.gs
- apps-script/department-dashboard/Escalations.gs
- tests/unit/heatmap-fallback.test.js
- tests/unit/journey-fallback.test.js
- tests/unit/outbound-report.test.js
- tests/unit/outbound-fallback.test.js
- tests/unit/agent-day.test.js
- tests/unit/escalations-snapshot.test.js
- CLAUDE.md
- docs/invariants.md
- docs/architecture.md
- docs/known-issues.md
- docs/conventions.md
- docs/client-ui-conventions.md
- docs/per-call-capture.md
- docs/operator-state.md
- docs/fix-history.md
- docs/sub-queue-split-plan.md
- docs/outbound-callback-dept-plan.md
- docs/module-dependencies.md

CHANGES:
PCR-1 | InboundReport.gs | `inboundQueuesForDept_` unions `getInboundQueueAliases_(child)` for each one-level child (new `inboundChildDepts_`, fail-closed to []) unless `{includeChildren:false}`. The queue-split narrowing callers already pass false and are unchanged.
PCR-2 | InboundReport.gs, OutboundReport.gs | New `inboundDeptFinalLabels_(dept)` returns own + children labels, lowercased and deduped. `inboundDeptPredicate_`, the heatmap sheet fallback and the outbound sheet fallback all use it, and the two private copies were deleted.
SEC-7 | InboundReport.gs, journey-fallback.test.js | `inboundCallJourneySheetFallback_` gets a lazy `reasonOk()` (company view / admin / allDepts / `callIdInDeptMissedReport_`) before any miss reason; a gate-closed caller gets a reason-less `{available, found:false}`. `insurer: null`. The parity test's Neon-side input no longer carries an insurer the real query cannot return.
PCR-3 | OutboundReport.gs, outbound-report.test.js, outbound-fallback.test.js | New `obTodayIso_()`. The SQL is `c.call_date >= '<today>'::date - N` and the fallback compares with `>=` using the same today.
PCR-9 | OutboundReport.gs | `runOutboundVettingCheck` returns `FAILED (outbound served from the <src> copy …)` when `ob.meta.fallbackSource` is set.
PCR-5 | AgentDay.gs, agent-day.test.js | New `agentDayLikePattern_` (quoted JSON name, `\ % _` escaped). `truncated` is set when `cap.inbound.length > AGENT_DAY_MAX_CALLS_`. The source pin was updated to the bound helper.
PCR-8 | Escalations.gs, escalations-snapshot.test.js | New `escSnapshotAfterWrite_(conn)` sets autocommit true, then does a forced refresh. It is called after the commit + log line of all 8 non-delete mutations.
INV-30 | InboundReport.gs, MissedCallsReport.gs, OutboundReport.gs + docs | Bumps: `inbound:v11`, `inboundHeatmap:v4`, `missed:v18`, `outboundReport:v4`. Every doc claim was synced, and the future plans in sub-queue-split-plan / outbound-callback-dept-plan now target v19 / v5.

TEST RESULTS: passed.
- `node --test`: 1846/1846 (TZ=America/Chicago).
- INV-16 guard: clean. `module-deps --check`: clean. `CI=1 npm run lint:gas`: clean. `npm run ci:ui`: all stages passed.
- Every new or changed test was bite-checked red against the pre-change files.
REGRESSION RISKS:
- PCR-1/PCR-2: parent depts' Inbound / Outbound / Missed / heatmap numbers grow by their sub-queues' raw-named and on-hold-answered calls. That is the documented intent, but managers will see changed figures after deploy.
  - The Dept Config modal's inbound-queue discovery now shows a child's raw queue attributed to its parent, which is its documented first-match behaviour.
  - The cached Dept Config init blob refreshes on the next save or after 6 h.
- SEC-7: an entitled caller still gets reasons. The F-4 Missed-report lookup now also runs on a manager's fallback MISS, which is cached, so this is cheap.
- PCR-5: agent names with LIKE wildcards or quotes are escaped. If journeys were ever stored with a different JSON escaping (non-ASCII as \u escapes), the quoted pattern would miss rows that the old bare pattern caught. The writer is JSON.stringify, which keeps non-ASCII raw.
- PCR-8: adds one bounded read (≤150 rows) per escalation write. It is best-effort and cannot fail a committed write.
INVARIANTS AT RISK: None.
- INV-30: honoured with four version bumps.
- INV-55 / INV-01: no new write path.
- The queue-split narrowing still passes `{includeChildren:false}` (Phase 2 unchanged).
- INV-53 / INV-04: untouched.
NET SCORE: 1 − 0 = 1.
- Production fix: PCR-3. The off-by-one fires every day that has an uncalled abandon exactly 3 days old, and the UTC date is wrong every evening.
- PCR-1/PCR-2 fire only where a child dept has raw aliases or on-hold labels configured, which is unmeasured, so they were not counted.
- The rest need an outage or a crafted probe.

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard. | BLOCKS DEPLOY: N
- Optional: re-run `runInboundQcdParityCheck` for a parent dept (e.g. Sales / CSR) after deploy to see the sub-queue roll-up land. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The per-dept callback table (next feature) must now bump `outboundReport:v4` -> `v5`, and the planned sub-queue Phase 3 Missed split bumps `missed:v18` -> `v19`. Both plan docs are updated.
- `callJourneyDeptPredicate_` (the journey's own scoped lookup) was not checked for the PCR-2 label roll-up. It is defence-in-depth behind the F-4 gate, so a miss there only routes a child's on-hold call through the gate.
- Remaining broad-scan batches 7–11 (`.cycle/blocks/195-broadscan-0923-plan.md`).

DOCUMENTATION UPDATES NEEDED:
- Done:
  - docs/per-call-capture.md (roll-up rule, SEC-7 fallback rules, pendingTail)
  - Operator State #63 (PCR-9)
  - docs/fix-history.md (Batch 6 section)
  - INV-30 + every cache-version mention
- None outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
