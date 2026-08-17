---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- The queue-split adoption round (Operator State #42's ship list): every remaining DQE reader routes through applyQueueSplitToRows_, so QUEUE_SPLIT_SCOPE=dept is now a one-property flip with one definition of "a department's calls" everywhere.

Files modified:
- apps-script/department-dashboard/Data.gs (helper: opts.narrowSlots -- K..AC timeline rebuilt from per-queue `mt`, rollback restores slots; NEW queueSplitNarrowedCopy_ for shared-array readers)
- apps-script/department-dashboard/MissedCallsReport.gs (Phase 3: both paths unified onto the DAL fetchers -- the parity dal-cutover pins certify -- then ONE narrowing hook incl. slots; meta.queueSplit* fields; key suffix x2)
- apps-script/department-dashboard/IndividualReport.gs + InsightsReport.gs (Phase 4: sheet path widened to col AI, REP-10-bounded, carries queueSplit; narrowed pre-aggregation so cards/trend/prior/team-avg inherit; key suffixes)
- apps-script/department-dashboard/CompanyOverview.gs (per-dept attribution split from the company pass and narrowed via clone-per-dept; the company HERO stays all-queue BY DESIGN -- company-wide every call counts once; 90-day + YTD trends narrowed; overviewCacheKey_ + YTD key suffixed -- busts inherit via the single helper)
- apps-script/department-dashboard/Alerts.gs (rows carry queueSplit from both sources -- sheet read widened, REP-10-bounded; computeDeptAnswerRateForDate_ narrows per dept on clones of the shared per-date memo, so the threshold fires on the number the dashboard displays)
- apps-script/department-dashboard/AgentHome.gs (home detail narrowed incl. slots; history narrowed before the monthly rollup; both cache tags + agentHist key gain the scope)
- tests/unit/queue-split.test.js (+4: narrowSlots on/off, B-1 rollback restores slots, the copy variant's off-zero-copy + shared-original-pristine pins)
- docs/operator-state.md #42 (ship list COMPLETE + flip checklist), CLAUDE.md (sub-queue bullet's flip sentence + index line 42)

CHANGES:
QS-1 | Data.gs | applyQueueSplitToRows_ gains opts.narrowSlots: for matched rows it REBUILDS the 19-slot missed timeline from the dept-matched queues' `mt` (the same pipeline pass wrote both, same CST convention), assigning fresh arrays so shallow clones stay safe; the B-1 whole-window rollback restores the original slots reference. queueSplitNarrowedCopy_ is the non-mutating per-dept variant for SHARED row arrays (Overview's one-fetch loop, the alert memo): off = the same array untouched (zero cost), dept = shallow clones narrowed.
QS-2 | Missed | Phase 3. The sheet fallback now reads via sheetFetchDqeRows_ + missedGridsFromDal_ -- the exact path dal-cutover.test.js pins byte-identical to the old raw range read -- so both sources meet at ONE narrowing hook (counts + timeline). Sentinels carry no split, so the queue-only abandoned section is untouched by construction. meta reports scope/applied/fellOpen/unmatched.
QS-3 | IR + Insights | Phase 4. Sheet rows now carry col AI (Math.min(QUEUE_SPLIT, getMaxColumns()) -- a pre-Phase-1 34-col sheet reads clean); one applyQueueSplitToRows_ call before the aggregation loops, so the per-agent cards, monthly trend, prior window, team average, gap-vs-team and call-share all inherit.
QS-4 | Overview | The single mixed loop split in two: the company aggregate keeps the all-queue rollup (each row counted once company-wide -- narrowing would change nothing but cost), and per-dept attribution accumulates from each dept's own narrowed clone-view. Same for the YTD chart. Off-path parity: the clone variant returns the SAME rows untouched when off, and the rendered gate (payloads from the REAL getCompanyOverview) passed.
QS-5 | Alerts | The engine's per-date memo rows carry queueSplit from both sources; per-dept narrowing runs on synthesized DAL-shaped clones so the memo shared across 14 depts is never mutated. The low-answer-rate threshold now evaluates the same number the dashboard shows.
QS-6 | Agent app | Home detail (trend + missed incl. slots) and history narrow for the agent's dept; the computeSummary_-derived KPIs already inherited. Cache tags carry the scope so a flip can't cross-serve.
QS-7 | Cache keys | missed x2 / individual / insights / companyOverview (via the single overviewCacheKey_ helper, so OrphanFix+DeptConfig busts inherit) / overviewChartYtd / agentHome team+me / agentHist all suffix the scope (CORE-3). No version bumps -- the version tracks aggregation-RULE changes; both modes are the same rule at different scope (the S2-0 precedent).

TEST RESULTS: passed. node --test 732/732 (+4 adoption pins; every touched reader's existing suite green: missed-report 9, dal-cutover 16, individual+insights 33, agent-home 10, overview-dqe-silence 5, queue-split 32). INV-16 green; claude-md-split + cache-version-sync + cross-file-pins green. npm run ci:ui all stages (drive-agent 20; drive-smoke's Overview assertions certify the loop restructure's off-path at the rendered level).

REGRESSION RISKS:
- The Overview loop restructure is the largest surface: off-path behavior is construction-equal (same accumulation body, same guards, clone variant returns identical references when off) and rendered-gate-verified, but it lacked a unit-level e2e pin before this round and still does (follow-on).
- The Missed sheet path swapped its raw range read for the DAL primitive; dal-cutover pins that parity, and the missed suite passes through the new path.
- With the flip ON, the DQE-silence watchdog's semantics sharpen (documented in #42): a dept whose roster answered only OTHER depts' queues while its own queues took calls reads as agent-dark -- arguably the correct signal.
- Alerts' per-dept narrowing only engages when scope=dept; off is byte-identical (the clone branch is gated).

INVARIANTS AT RISK: None violated. The S2-0/B-1 fail-open contract is the shared helper's and every adopter inherits it; INV-05/23/25/28/29/53 inherit narrowing BENEATH them unchanged; INV-30 deliberately suffix-not-bump per its own S2-0 note; REP-10 honored at both widened sheet reads.

NET SCORE: 1 completed rollout (7 surfaces, one definition) - 0 known new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- THE FLIP (when desired, after deploy): (1) auditQueueSplitAttribution() and fix unmapped raw names (Dept Config aliases); (2) set QUEUE_SPLIT_SCOPE=dept; (3) spot-check CSR vs Spanish for a crossover agent -- partition, and all surfaces agree | BLOCKS DEPLOY: N
- Remember the col-AI coverage floor (#40): dates before the Phase 1 deploy can never narrow -- they keep the rollup (fail-open #2), which is correct but visible as "split from <date>" | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- computeActiveAgentsInRange_ deliberately un-narrowed (picker inclusion, not figures) -- documented in #42.
- A unit-level getCompanyOverview e2e suite would pin the loop restructure tighter than the rendered gate alone.
- Client chips for narrowed IR/Insights/Overview surfaces (the dept table already has them) -- cosmetic, on demand.

DOCUMENTATION UPDATES NEEDED:
- DONE: operator-state #42 (complete list + flip checklist), CLAUDE.md flip sentence + index line. None remaining.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
