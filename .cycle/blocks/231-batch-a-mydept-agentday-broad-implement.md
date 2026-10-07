---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch A (owner plan 2026-10-06, My Department + Agent Day)
- A1: "ans/day" counts only days with at least one ring (a DQE row with no rings is not a working day)
- A2: ans/day renders beside the rung total in the Answered / Missed cell; subtotal/total rows show the team's answered per AGENT per day (floaters + the dept's team-average excludes left out); the hidden "Ans / day" column is removed (CSV/TSV keep an "Ans / day" column after Answer %)
- A3: the bar's inline answer rate is removed (the Answer % column is the same figure)
- A4: Agent Day shows two labelled tile rows -- Inbound (Rung / Answered / Missed / Talk time / Transferred / Hold) and Outbound (Placed / Connected / Talk time / Unconnected / Attempts), with "Outbound not captured" instead of zeros when the outbound list is not the whole day
Files modified: apps-script/department-dashboard/Data.gs, AgentDay.gs, script-1-core.html, script-5-dept.html, script-10-escalations.html, dashboard.html, styles.html, OrphanFix.gs (comment); tools/ui-harness/build-harness.js (Agent Day fixture); tests/unit/compute-summary.test.js, subqueue-access.test.js, agent-day.test.js; CLAUDE.md, docs/invariants.md, docs/known-issues.md, docs/conventions.md, docs/architecture.md, docs/operator-state.md, docs/client-ui-conventions.md, docs/per-call-capture.md, docs/regression-scenarios.md, docs/module-dependencies.md (regenerated)

CHANGES:
A1 | Data.gs | computeSummary_ adds a day to an agent's `a.days` only when that DQE row's totalRung > 0; `summary:v22` -> `summary:v23` (forced miss on deploy)
A2 | Data.gs | totals.ansPerDay is now answered per AGENT per day: `ansPerDayAnswered` / `ansPerDayAgentDays` over roster rows minus `teamAvgExcludeSet_(dept)` (new helper over getTeamAvgExcludes_; empty set on failure = everyone in). The team-volume `totals.daysActive` + non-enumerable `activeDayKeys` (D-6) are removed -- their only reader was the removed column. combineSummaries_ sums the pair across depts and subtracts a crossover agent's repeat only when BOTH appearances counted
A2 | script-1-core.html, script-5-dept.html, dashboard.html, styles.html | `ansPerDayHtml_` renders "· N.N ans/day" after the "(rung)" total (agent rows: own ring-days; total/subtotal rows: the team pair, told apart by `ansPerDayAgentDays`); COLUMNS loses ansPerDay and both theads (My Department + the Overview Department-detail table) lose the th; the dead `num1` fmtCell branch is removed; deptTableGrid_ splices "Ans / day" back into the export right after Answer % (same column order as before)
A3 | script-1-core.html | answeredBarHtml_ no longer prints `.ans-rate` (only caller: the My Department / Overview agent table, whose total and subtotal rows also carry Answer %)
A4 | AgentDay.gs | agentDayInboundRole_ carries the agent's own leg hold + start time and `transferredOn` (agentDayTransferredOn_: a later leg, > 1 s after the agent's answered leg started, that is someone else's -- the transfer probe's rule); agentDayShapeInbound_ adds agentHoldSec / transferredOn; agentDayCounts_ adds inboundTalkSec / outboundTalkSec (talkSec stays their sum), agentHoldSec, holdCalls, transferredOn, outboundAttempts and the unconnected brief / real / unknown split via OutboundReport's outboundClassifyRing_; new agentDayOutboundCaptured_ + AGENT_DAY_OUTBOUND_CAPTURE_START_ ('2026-07-10') -> meta.outboundCaptured / meta.outboundCaptureStart
A4 | script-10-escalations.html, dashboard.html, styles.html | adKpiRowsHtml_ renders the two labelled rows; Transferred / Hold read "–" ("needs the call journey") off a full-tier day; outbound shows a "not captured" note naming why (Neon down / before capture start / no capture rows)

TEST RESULTS: passed -- `TZ=America/Chicago npm run ci` 2200/2200 + INV-16 + module-deps (regenerated: Data.gs -> DeptConfig, AgentDay -> OutboundReport); `npm run lint:gas` clean; `npm run ci:ui` all stages passed (drive-admin 125/125 incl. Agent Day). New/rewritten tests: v23 ring-day definition, team figure with excludes, combined pair sum + crossover (both counted / one excluded), Agent Day counts split, transferredOn incl. the same-second ring, outboundCaptured incl. the pre-capture full day. Bite-checked 5 (zero-ring day counted, excludes ignored, crossover not removed, simultaneous ring as transfer, pre-capture outbound shown) -- all red.
REGRESSION RISKS:
- The CSV/TSV "Ans / day" value on TOTAL/SUBTOTAL rows changes meaning: team answered per day -> answered per agent per day. Agent rows change only where an agent had no-ring DQE days.
- `daysActive` also feeds the agent app's team blob (AgentHome.gs), which carries but never renders it; `agentHome:v1` is not bumped, so it can be up to 6 h stale after deploy, invisibly.
- "Transferred" is a heuristic over journey timing: a consult/conference leg to a colleague after answering also counts. The tile foot says "answered, then moved on", not "transferred by".
INVARIANTS AT RISK: None. INV-30 bumped (summary:v23, all live doc mentions synced -- cache-version-sync green); INV-26 + INV-53 composed (floaters out first, then excludes; totals keep everyone, R18); INV-05 ATT untouched; INV-04 exact names; INV-01 no writes.
NET SCORE: 1 − 1 = 0 (A1 fired in production on any no-ring DQE row; the documented Transferred heuristic is the one new failure mode)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard -- `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version). Then walk S47 (Agent Day tiles) and glance at S1 / S43 (table + CSV).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- docs/next-steps.md cites `OutboundReport.gs:85-86` for the 6c gate; it now sits at :121 (found by the Batch-planning survey).
- `.ans-bar--fail .ans-rate` CSS still serves the Escalations bar (script-10 uses .ans-rate there); no dead rule.
- Batch B (inline agent panel), Batch C (outbound probe), D, E per the plan.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made (CLAUDE.md TEAM_AVG_EXCLUDES consumers, INV-30, the version tables, client-ui-conventions column model, per-call-capture Agent Day tiles, S47).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
