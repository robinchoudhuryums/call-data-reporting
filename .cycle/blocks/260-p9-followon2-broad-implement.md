---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- P8-L1 -- an Insights card mixed two teams: its % Ans marker read the department rate while its count bars and the behind-team rule read the manager-excluded team.
- P8-L2 -- an agent on the team-average exclusion list was still shown against the benchmark they sit outside of (a team chip, team markers on their bars, a bar in the Gap vs team chart).
New capabilities (G/ST):
- MA-1 -- Mark all shown: every partial-day suggestion on screen marked in one confirmed batch (owner go-ahead 2026-11-16).
- VP-1 -- an agent's own vs-prior figures on counts are per credited day in the Individual Report and Insights (owner decision 2026-11-16).
Files modified:
  apps-script/department-dashboard/PartialDays.gs, IndividualReport.gs, InsightsReport.gs, CacheWarm.gs (comment), OrphanFix.gs (comment), dashboard.html, script-1-core.html, script-4-nav.html, script-6-ir.html, script-7-admin.html, script-8-insights.html
  tests/unit/team-per-day.test.js, partial-day-suggestions.test.js, client-correctness.test.js
  tools/ui-harness/build-harness.js, drive-admin.js, drive-deptoutbound.js, README.md
  CLAUDE.md, docs/operator-state.md, docs/invariants.md, docs/regression-scenarios.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/known-issues.md, docs/conventions.md, docs/architecture.md, docs/module-dependencies.md, tests/README.md

CHANGES:
MA-1 | PartialDays.gs | `savePartialDays({items:[{date, agent, credit}], reason})`: admin-only, every item validated before anything is written (date, roster name, share from the list, no duplicates, at most 200), one lock, one usage row; a day that already has a row (a mark, or a reviewed row) is updated in place.
MA-1 | dashboard.html, script-7-admin.html | "Mark all shown (N)" beside Find, offered only while a suggestion is on screen. It asks first, naming the count and the one reason chosen in the form, then sends one request with each day's own suggested share.
VP-1 | IndividualReport.gs, script-6-ir.html | Cards carry `priorDays` + `priorPerDay` when a comparison is on; the prior row of a count tile reads "Prior 22.9 / day" and its badge compares the two per-day figures. Rate tiles unchanged; with under one credited day on either side the totals are compared as before. `individual:v14`.
VP-1 | InsightsReport.gs, script-1-core, script-6-ir, script-8-insights, script-4-nav | Cards carry `daysPrior`. `creditedPair_` gives an agent's credited days in the two windows; with it the change badges on answered / missed / rung / total talk time compare per day worked (and say so on hover), and the Improving / Slipping classification is fed from the card's own days. The stored delta blocks are untouched, and the department's own vs-prior figures are not re-based. `insights:v29`.
P8-L1 | script-8-insights.html | The % Ans marker on every card reads the manager-excluded team rate (`meta.teamAvgBasis.pct`).
P8-L2 | script-8-insights.html | An exempt agent's card shows "exempt" in place of the team chip and has no team markers; the Gap vs team chart leaves them out and names them under the chart ("Not shown: … (excluded from the team benchmark)"). The Trend basis still draws their line.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,144 pass / 0 fail (six new tests across team-per-day and partial-day-suggestions); `npm run lint:gas` clean; the module-map check clean; `npm run ci:ui` all 18 driver runs passed, with six new rendered checks (Mark all shown asking first and sending one request; count badges vs prior per day worked; the exempt card and gap chart; the % Ans marker's team). Bite-checks: 8 of 8 bite.
REGRESSION RISKS:
- VP-1 changes every agent-level vs-prior badge on counts for any agent whose days worked differ between the two windows, and can move an agent between Improving / Steady / Slipping. Intended; agents with the same days in both windows see the same numbers as before.
- P8-L1 moves the % Ans marker slightly in departments with an excluded manager (in the fixture 90.4% -> 90.1%).
- P8-L2 removes the excluded manager's bar from the Gap vs team chart; the chart says who is not shown.
- MA-1 writes many marks from a rule of thumb in one click. It always asks first and any mark can be removed, but a careless confirm marks days that were whole.
INVARIANTS AT RISK: None broken. INV-01: `savePartialDays` is a third write inside the admin-gated Partial Days carve-out (gate, validation, lock, stamp, usage row; documented). INV-26 / R18: the exempt handling and the marker basis follow the existing ruling. INV-28: the prior WINDOW is unchanged; only how an agent's counts are compared across it. INV-30: `individual:v14`, `insights:v29`, every mention synced.
NET SCORE: 2 production fixes − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (push + new version). | BLOCKS DEPLOY: N
- Tell managers that an agent's change-vs-prior on counts is now per day worked (the badge's hover says so). | BLOCKS DEPLOY: N
- Walk S73's "vs prior", "exempt" and mark-all steps; then `runLiveSmoke`. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Individual Report's prior row per credited day has no rendered check (the harness IR run has no comparison on); it is covered by unit tests and a source pin.
- The Insights help text does not yet say the change badges are per day worked (the hover does).
- Narrow the suggestion read once its production timing is known, if it needs it.
- team-tools' matching change: a handoff block was given to the owner this session; when it lands, update Operator State #68 (a sixth tab) and #94 ("planned, not built").

DOCUMENTATION UPDATES NEEDED:
- None -- written in this session.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
