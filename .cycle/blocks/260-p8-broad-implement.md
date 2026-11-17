---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (P8 is new capability from the owner's follow-up plan of 2026-11-13; "Batch 8" was read as the plan's P8 -- the scan's own Batch 8 was implemented 2026-11-10 and merged in PR #413)
New capabilities (G/ST): P8 -- partial days in the Individual Report and Insights: every agent-vs-team VOLUME comparison moves from window totals to per credited day.
Files modified:
  apps-script/department-dashboard/Util.gs, IndividualReport.gs, InsightsReport.gs, CacheWarm.gs (comment), OrphanFix.gs (comment), dashboard.html (help text), script-1-core.html, script-6-ir.html, script-8-insights.html, styles.html
  tests/unit/team-per-day.test.js (new), client-correctness.test.js
  tools/ui-harness/drive-smoke.js, drive-deptoutbound.js, README.md
  CLAUDE.md, docs/operator-state.md, docs/invariants.md, docs/regression-scenarios.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/known-issues.md, docs/conventions.md, docs/architecture.md, docs/module-dependencies.md, tests/README.md

CHANGES:
P8 | Util.gs | `agentDaysBlock_(agent, daySet)` -> `{ active, credited, partial, marks? }` from the days an agent had any call on; both reports ship it.
P8 | IndividualReport.gs | Each card carries `days` and `perDay` (rung / missed / answered per credited day; null under one credited day). `teamAvg` carries `perDay` -- the active, non-excluded roster's calls over their credited agent-days. The two volume sentences ("Call volume ...", "Missed calls ...") compare per day worked. The per-agent window averages stay in the payload. `individual:v13`.
P8 | InsightsReport.gs | Each `agentData[]` card carries `days`; `meta.teamAvgBasis` carries `agentDays` (the baseline's own members, team-average excludes out). `insights:v28`.
P8 | script-6-ir.html, styles.html | The three count tiles keep the window total as the big number and add "24.8 / day" over "Team 20.1 / day" with a percent badge comparing those two (a plain "-" under one credited day). The card title says "vs Team Avg, per day worked" and how many days had calls, or the attendance when a day is marked. "Copy data" gains an "Agent / day" column so a total is never set beside a per-day team figure.
P8 | script-8-insights.html | Four surfaces move to per credited day: the above / below team chip ("24.8 vs 20.1 ans/day"), the Answered and Missed bars on each card (the number beside the bar stays the total), the Gap vs team chart for a count metric, and the call-share benchmark -- now each agent's share of the days worked instead of a flat equal share. Each keeps its window comparison when the payload has no days.
P8 | script-1-core.html | Shared pure helpers: `perDayOf_`, `attDaysText_` / `attDaysHtml_`, `perDayText_`; `attendanceHtml_` takes the caller's own workday count.
P8 | dashboard.html | Help text for the Individual Report and Insights says the count comparisons are per day worked.
P8 | docs | Operator State #94 (the P8 paragraph), INV-27 note, INV-30 versions, S73's two P8 steps, client conventions, fix-history, coverage map, harness README.
(test) | drive-deptoutbound.js | The P4 fold-survives-reload check reloaded 250 ms after a storage write and failed once when four drivers ran side by side; it now waits for the write to land first.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,119 pass / 0 fail (17 new in team-per-day.test.js); `npm run lint:gas` clean; the module-map check clean after a regenerate; `npm run ci:ui` all 18 driver runs passed on the second run. The first run failed ONE check that is not P8's: the P4 fold-survives-reload check in drive-deptoutbound reloaded 250 ms after a browser-storage write and came back with the key unset while four drivers ran side by side (it passes alone, and passed in every earlier run); it now waits for the write before reloading. Bite-checks: 11 of 11 bite after one fix -- dropping the "a day needs a call" gate in the Individual Report passed every test, so a test now pins that a 0 / 0 / 0 row is not a day in either report, and both gates bite.
REGRESSION RISKS:
- By design, the vs-team volume comparisons change for every agent, marks or not: an agent who was out for part of the window is no longer read as below the team for it, and one who worked every day loses the edge that gave them.
- A second, quieter change on the Insights cards: the Answered / Missed bar marker and the team chip now use the manager-excluded baseline (the R18 basis the gap chart already used) because that is the basis the agent-days are counted on; before they divided the department total by every active roster agent. The % Ans bar marker still reads the department rate.
- A stray call taken on a day off counts as a whole day worked in these comparisons unless the day is marked. My Department's ans/day always worked this way; the two reports' window totals did not.
- A payload cached before the deploy cannot be served (both prefixes were re-versioned), so there is no mixed state; the window fallbacks exist for hand-built fixtures.
INVARIANTS AT RISK: None broken. INV-26 / INV-53: the team agent-days cover the same members as the sums they divide (pinned). INV-27: the per-agent window denominator is unchanged and still in the payload; the entry now notes the per-day basis. INV-30: `individual:v13`, `insights:v28`, every mention synced (cache-version-sync). INV-25 / INV-05 (ATT) and INV-28 (prior window) untouched. Privacy: the reason reaches neither payload (pinned).
NET SCORE: 0 production fixes − 1 new failure mode (a stray call on a day off counts as a day worked in these comparisons) = −1

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (push + new version). | BLOCKS DEPLOY: N
- Walk S73's two P8 steps, S11 and S14 after the deploy; then `runLiveSmoke`. | BLOCKS DEPLOY: N
- Tell managers the count comparisons on the Individual Report and Insights are now per day worked (the help text says so). | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The same agent's "vs prior period" figures are still window against window (normalised per working day only on a length mismatch); an agent whose attendance differed between the two windows is not credited. Not in P8's scope ("team comparisons").
- On an Insights card the % Ans bar marker reads the department rate (managers in) while the count bars and the behind-team classification read the manager-excluded baseline.
- An excluded manager still gets a team chip and a bar in the Gap vs team chart (as before P8); they sit outside the benchmark, so both could be dropped.
- The Insights email and the digests carry no agent-vs-team volume comparison, so nothing changed there; the Individual Report's emailed image shows the new tiles.
- P9 (suggest likely partial days) would also catch the stray-call-on-a-day-off case.
- team-tools' matching change (Operator State #94) is still planned, not built.

DOCUMENTATION UPDATES NEEDED:
- None -- written in this session.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
