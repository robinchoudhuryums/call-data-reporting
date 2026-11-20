---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (MD3 is an owner-plan batch, new capability by owner ruling 2026-11-20, not a scan finding)
New capabilities (G/ST): MD3 -- ONE trend chart on My Department with a "Team total / By agent" switch. The Agents section's per-agent "Trend" basis and the Trends section's team line were two charts on the same 12-month axis; they are now one. In the admin brief the Team row opens it By agent and the Trend row as the Team total.
Files modified:
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/styles.html
- apps-script/department-dashboard/script-4-nav.html (chart tips)
- tests/unit/brief-accordion.test.js, tests/unit/insights-partial-month.test.js
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/regression-scenarios.md (S14, S37, S61), docs/fix-history.md (MD3 row), tests/README.md
- .cycle/STATE.md, .cycle/blocks/260-md3-broad-implement.md

CHANGES:
MD3 scope | script-8-insights.html, dashboard.html | `#ins-trend-scope` (Team total / By agent) on the Trends chart; `insTrendScope` drives `insRenderTrendChart_`, which hands off to `insRenderTrendByAgent_` on the SAME canvas and chart instance. Team total is unchanged (every metric, Monthly / Daily, Line / Calendar).
MD3 By agent | script-8-insights.html | One line per active agent over the 12-month axis, monthly only, for Answered / Missed / % Answered (`#ins-trend-agent-metric`). A dashed neutral reference (PURE `insTrendAgentRef_`): the team's own monthly rate for % Answered; for a count, the average per agent shown who was active that month, with team-average-excluded managers left out. Legend solo / compare / hide and the point click into the Individual Report are kept; the reference is never dimmed and never a drill target. The controls that belong to Team total hide; the switch hides when there are no agents to plot.
MD3 Agents section | dashboard.html, script-8-insights.html | The "Trend" basis button and `insRenderCardsChartTrend_` are gone. The section shows only the gap bars; its basis sub-toggle is hidden for everyone (Abs stays inert, reachable from the admin A/B remote).
MD3 brief rows | script-8-insights.html, dashboard.html, styles.html | `#ins-trend-wrap` is one element whose home is the Trends fold. The row a viewer opens takes it (`insTrendClaim_`): Team shows it By agent above the gap bars and the team detail, Trend shows it as the Team total. With both rows open, the other row shows a one-line note offering it back; a row that closes while holding it hands it to the other open row (PURE `insTrendRowTaker_`). With no brief (a manager, View-as) the chart stays in the Trends fold.
MD3 gating | script-8-insights.html | Every draw-on-open gate asks about the fold HOLDING the chart (`insTrendChartOpen_`, `insTrendHostFold_`); a moved canvas is redrawn, never resized.
MD3 prefs | script-8-insights.html | `trendScope` and `trendAgentMetric` are saved. A row sets the scope on screen but never the saved one (`insTrendScopePref_`). A blob saved on the old Trend basis carries over as By agent with its metric (PURE `insTrendPrefsFrom_`).
MD3 A/B remote, tips | dashboard.html, script-8-insights.html, script-4-nav.html | The remote's Basis row loses Trend and gains a Scope row (Team / Agent) forwarding to the real switch. Two chart tips added.
MD3 tests | unit + rendered | Six new tests in brief-accordion (who takes the chart, the reference line, the prefs carry-over, the markup, the gating, the saved scope); the partial-month pin follows the renamed renderer. drive-smoke: four admin checks (Team opens By agent above the gap bars; Trend takes it; "show it here" returns it; a closing row hands it over) and one manager check (the fold holds the chart, the switch goes By agent and back to exactly what was there).

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,177 pass / 0 fail (1 skipped, pre-existing); `npm run lint:gas` clean; module map up to date. `npm run ci:ui`: the first full run (before the new rendered checks) passed all 18; the second full run passed 17 and failed the manager smoke shard on MY new check only (it assumed a line chart where an earlier step had left the Calendar view -- the page was right); the check was corrected and both smoke shards then passed (admin 119/119, manager 87/87). No client code changed after the second full run. Five pins bite-checked. Regression Scenarios not walked live (needs a deploy).
REGRESSION RISKS: (1) Admin brief: opening the Team row now also draws the trend chart (one more chart to render on open). (2) An admin who used the Agents section's Trend basis finds it under Trends / the Team row instead; a saved choice carries over. (3) The count reference is the average of the agents SHOWN, so with a hand-picked subset it is that subset's average, and the label says "shown". (4) The chart element moves between two containers in the brief; exports and Print capture it wherever it currently sits.
INVARIANTS AT RISK: None. Client presentation only: no server payload, cache key or aggregation rule changed. INV-26 is respected by the new reference line (excluded managers are out of the average); INV-41 (no data labels on a many-line chart; every chart through `safeChart_`) holds; INV-53 unaffected (the lines are the report's own agent cards).
NET SCORE: 0 − 0 = 0 (new capability; no production fix claimed)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard and walk S61's MD3 step (admin: Team row, Trend row, the hand-over) and S14 / S37's MD3 steps (the switch in the Trends section) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The plan said to carry over the share-link state. Share links and saved views carry dates, comparison, agents and department only -- no chart setting -- so there was nothing to carry.
- Noticed, NOT verified: several older click handlers are bound on `#insights-page`, and the brief (`#ins-brief`) sits outside it, so a handler such as the agent card's "open Individual Report" link may not fire while its section is inside a brief row. Unreachable today (the Cards view is hidden); worth checking before the Cards view returns.
- By agent has no Daily view and no Calendar (the per-agent series is monthly only); a daily per-agent series would need server work.
- The Agents section's basis sub-toggle markup and the Absolute renderer stay in place, hidden (the existing removal convention).
- Next in the owner's plan: MD4 (the queue trend chart moves into Queue health, linked to its table).

DOCUMENTATION UPDATES NEEDED:
- None (done in this change).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
