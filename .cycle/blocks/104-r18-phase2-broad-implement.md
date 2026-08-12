---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18 item 3 | Manager call volume must not be factored into per-agent averages and benchmarks (owner ruling), while staying in dept totals and rates

Files modified:
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/styles.html
- apps-script/department-dashboard/CacheWarm.gs
- tests/unit/insights-report.test.js
- CLAUDE.md, docs/invariants.md, docs/architecture.md, docs/conventions.md, docs/known-issues.md, docs/client-ui-conventions.md, docs/sub-queue-split-plan.md

CHANGES:
R18-3 | InsightsReport.gs | The mechanism already existed -- INV-26's `TEAM_AVG_EXCLUDES` / Dept Config "Team Avg Excludes" -- but ONLY `IndividualReport.gs` consumed it. Insights' divisor was `activeRosterCount` with no exclusion, and its own comment claimed the divisor "matches the Individual Report's", which was half-true and is exactly how the two drifted. New parallel accumulator `teamAvgBase` + `activeRosterAvg` fills alongside `teamCurr` inside the same roster branch, and the payload gains `meta.teamAvgBasis` {agents, rung, missed, answered, ttt, pct, att, excludedAnsweredShare, excluded[]}. `pct`/`att` are RECOMPUTED over the excluded population rather than reused from teamStats -- a rate over a different population is a different rate.
R18-3 | InsightsReport.gs | Every dept-total accumulator (`teamCurr`/`teamPrev`/`dailyTeam`/`monthlyTeam`/`ytdTeam`/`deptAnsweredCurr`) is untouched, so `teamStats`, `rosterAgentCount`, all trends and every dept rate are byte-identical. That is the owner's boundary, encoded structurally rather than by convention.
R18-3 | InsightsReport.gs | Each agentData row carries `excludedFromTeamAvg`, reusing IR's exact field name so the existing "EXCLUDED FROM TEAM AVG" pill works unchanged (INV-26).
R18-3 | InsightsReport.gs | Cache `insights:v20` -> `v21`. Dept totals do not move but every "vs team average" comparison does, so stale blobs must not be served.
R18-3 | script-8-insights.html | Gap-vs-team chart reads `meta.teamAvgBasis`, falling back to the old teamStats basis when the payload predates v21 (a cached blob mid-deploy), so the chart never renders empty.
R18-3 | script-8-insights.html | Call-share equal-share benchmark: each row's SHARE % still divides by the dept total (dept totals include managers), and only the THRESHOLD moves -- `(100 - excludedAnsweredShare) / nonExcludedAnsweringAgents`. Splitting a flat 100% among the non-excluded would overstate it in the opposite direction. An excluded manager's row shows no delta and gets an "exempt" chip instead, since they are not measured against a benchmark they are deliberately outside of.
R18-3 | tests/unit/insights-report.test.js | Two tests: the exclusion case (dept totals keep the manager; the baseline drops them; the baseline rate is recomputed and provably differs from the dept rate; the excluded share is set aside; the per-agent flag is set) and the NO-OP case (with no excludes configured the baseline equals the dept rollup exactly) -- the latter matters because 13 of 14 depts have no excludes and their numbers must not move at all. Driven through the Dept Config SHEET, since Config.gs's seed is a frozen `const` the harness cannot rebind.

TEST RESULTS: passed. `node --test` 671/671 (+2); INV-16 green; cache-version-sync green after updating 7 doc/comment references; `npm run ci:ui` 56/56 + 16/16 + 30/30 + 14/14. Regression Scenarios: the automated equivalents are green; S14/S37 (Insights end-to-end) are live walks that cannot run pre-deploy and are listed as an operator action.

REGRESSION RISKS:
- FOUND BY THE NEW TEST, pre-ship: the config read used `department` where the function parameter is `dept`, and my own try/catch swallowed the ReferenceError -- the report rendered perfectly with the pre-fix numbers. Fixed, and the catch now LOGS: a silent fallback to the old baseline is the one failure mode this change must not have.
- Dept totals/rates: structurally unchanged (separate accumulator), pinned by the no-op test asserting basis == rollup when nothing is excluded.
- Mid-deploy cached blobs: the client falls back to the pre-R18 basis when `teamAvgBasis` is absent, so a v20 blob renders correctly rather than dividing by zero.
- An excluded name that no longer matches a roster agent (rename/typo) simply excludes nobody -- exact match per INV-04, same as IR.

INVARIANTS AT RISK: None violated. INV-26 is EXTENDED and its doc entry rewritten to state the scope ruling and name both consumers. INV-30 bumped (insights:v21) with the reason recorded. INV-27 (active-agent denominator) still holds -- the baseline is a subset of the same active-roster population. INV-53 (floater exclusion) unaffected and composes as before. INV-04 exact-name matching preserved.

NET SCORE: 1 production fix − 0 new failure modes = 1
(The reported symptom was live: every CSR teammate's call-share was measured against a benchmark diluted by a manager's token volume, and the same dilution applied to the gap-vs-team chart. The one failure mode this could have introduced -- silently falling back to the old numbers on a config-read error -- was caught by the new test before shipping and is now logged rather than swallowed.)

OPERATOR ACTIONS / DEPLOY:
- Populate Dept Config "Team Avg Excludes" for any OTHER dept with a call-taking manager on its roster. CSR is already seeded ('Robin Choudhury'); other depts exclude nobody until set. Admin modal, no redeploy | BLOCKS DEPLOY: N
- Walk S14 / S37 (Insights end-to-end) after deploying | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Insights EMAIL's behind-team block (`insEmailBehindBlock_`) and the at-a-glance headline's "N agents behind the team average" still classify against `teamStats`, not the new basis. Same class of inconsistency, one level down; deliberately out of scope for this phase since it changes email copy.
- Remaining owner items from this round: date clamp + workday accuracy (item 2), dark-mode zero baseline (4a), queue-metric Calendar (8).

DOCUMENTATION UPDATES NEEDED:
- DONE: INV-26 rewritten with the scope ruling + both consumers; INV-30 v21 entry; the CLAUDE.md TEAM_AVG_EXCLUDES bullet gained the scope sentence; 7 stale `insights:v20` references synced.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
