---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F4: the two Overview cache keys (companyOverview via overviewCacheKey_, overviewChartYtd) carry ':q' + qcdFreshnessTag_() -- their payloads embed queue data (tile QCD chips, the YTD abandoned series) and missed DATA-6's anchor
- F5: computeQcdReport_ raises DATA-4's outage flag (qcdFlagEmptyIfOutage_) on an empty fallback sheet and on a window with no rows, so Insights never caches a Neon-miss zero as real queue health
- F29: the Agent Day header/missed rings and the My Department inline panel's day strip are queue-split-narrowed to the row's dept, like the row they hang from
- F33: the Agent Day DQE read asks Neon for one agent, and the strip drops missed detail (agent filter skipped while narrowing is on)
- F61: an empty final-dept label union turns the on-hold LABEL arm off (SQL predicate + the sheet twin ihRowInDept_), so a call lands in exactly one dept
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/CompanyOverview.gs, QCDReport.gs, InboundReport.gs, DeptConfig.gs (comment), AgentDay.gs, script-5-dept.html, script-10-escalations.html
- CLAUDE.md (CacheService tiers KDD), docs/invariants.md (INV-30), docs/operator-state.md (#42), docs/per-call-capture.md (Agent-day view), docs/module-dependencies.md (regenerated)
- tests/unit/cache-key.test.js, company-overview.test.js, overview-qcd-snapshot.test.js, heatmap-fallback.test.js, agent-day.test.js

CHANGES:
F4 | CompanyOverview.gs | overviewCacheKey_ appends ':q' + qcdFreshnessTag_() (typeof-guarded; every bust site inherits it); getOverviewChartTrend's key appends the same. Two older pins that read "the key ENDS in the roster hash" updated to allow the trailing tag; INV-30 + the CLAUDE.md cache bullet list all four queue-anchored keys.
F5 | QCDReport.gs | computeQcdReport_: qcdFlagEmptyIfOutage_('computeQcdReport_') before the sheetData.empty return, and after the row loop when no Total-Calls row of the dept fell in the selected range (rangeRows). The flag fires only when this execution fell back (QCD_NEON_FELL_BACK_), so a reachable quiet window stays cacheable; getInsightsReport's existing qcdSnapshotReadFailed_ put-guard does the rest.
F29 | AgentDay.gs, script-5-dept.html, script-10-escalations.html | agentDayNarrow_(rows, scope, reqDept, narrowSlots) -> applyQueueSplitToRows_ on the requested dept when it is one of the agent's roster homes AND passes assertDeptAccess_ for the viewer, else the entitled home; no-op for an unrostered agent. getAgentDay narrows with narrowSlots (missed rings), getAgentDayStrip without. Client: the three agent-row builders add data-dept (combined-view group / outbound group), the panel stores AP_.dept (row's data-dept, else getRequestedDept()) and sends `department` to both RPCs. #42's ship list + per-call-capture updated.
F33 | AgentDay.gs | agentDayFetchDalRows_(from, to, {agentName, missedDetail}): `agents: [name]` on the Neon read unless QUEUE_SPLIT_SCOPE=dept (B-1 assesses fail-open from the dept's roster rows -- one agent's rows alone could fall open where My Department narrows); the strip passes missedDetail:false.
F61 | InboundReport.gs, DeptConfig.gs | inboundDeptPredicate_: labelArm = 'false' when the union is empty; ihRowInDept_ (heatmap + outbound sheet fallbacks): labelMatch requires a non-empty union. getAllFinalDeptLabels_'s comment now says why the empty union is single-counted. The PCR-1/PCR-2 heatmap test stubs a union (production's is never empty outside the fault).

TEST RESULTS: passed -- TZ=America/Chicago node --test: 2454 tests, 2453 pass, 0 fail, 1 skipped (CH-4 snapshot writer, by design). +5 tests, 3 pins updated. 7/7 manual bites caught. lint:gas clean; INV-16 guard clean; module-deps regenerated + --check clean. npm run ci:ui (playwright 1.62.1): all stages passed.
REGRESSION RISKS:
- F4: one cold Overview (+ YTD) cache fill per QCD date change -- the intended cost; the bust sites inherit the suffix through overviewCacheKey_.
- F29: an older client (open tab before the deploy) sends no `department`; the server then narrows to the agent's first entitled home -- identical to today whenever QUEUE_SPLIT_SCOPE is off (the default), where narrowing is a no-op.
- F33: the sheet DAL ignores `agents` (it reads the span), so the egress saving is Neon-only; the strip no longer receives slots it never used.
- F61: during a roster-read fault, an on-hold call whose label is mapped but whose entry queue belongs to another dept now counts ONLY in the entry queue's dept (it used to count in both).
INVARIANTS AT RISK: None -- INV-30 (keys extended by suffix, the CORE-3 pattern; no version bump needed, documented), INV-53/INV-26 untouched, INV-38 (the panel's dept is re-validated against the agent's roster homes AND the viewer's own gate).
NET SCORE: 0 production fixes (each is latent: a QCD-only landing, QCD_READ_SOURCE=neon, QUEUE_SPLIT_SCOPE=dept, DQE_READ_SOURCE=neon egress, a roster-read fault) − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- dept-config.test.js:386-390 / inbound-window-scope.test.js:261-268 messages ("nothing can double-count") are now true; left as is.
- The Agent Day standalone modal (getAgentDay from the Reports menu, script-10 ~2250) sends no department -- it narrows to the agent's first entitled home, which only matters under QUEUE_SPLIT_SCOPE=dept.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made here.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
