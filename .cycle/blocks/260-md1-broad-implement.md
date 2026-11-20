---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (MD1 is an owner-plan batch, new behaviour by owner ruling 2026-11-20, not a scan finding)
New capabilities (G/ST): MD1 -- "slipping" removed from the Insights Team row, the Agents heading and the agent cards. The direction of change is no longer shown as a verdict; only an improvement gets a pill.
Files modified:
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/dashboard.html
- tests/unit/insights-brief.test.js
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/regression-scenarios.md (S61), docs/next-steps.md, docs/operator-state.md (#94 wording), docs/fix-history.md (MD1 row), tests/README.md
- .cycle/STATE.md, .cycle/blocks/260-md1-broad-implement.md

CHANGES:
MD1 (a) | script-8-insights.html `insBriefAgents_` | The Team row is AMBER when any judged agent is behind the team average, GREEN otherwise. No red tier. The trend is not read: an agent on par with the team but down on the prior period is neither named nor counted. Names read "(behind)". Return shape unchanged (`red` is always empty). The `mismatch` argument and its caller variable are gone.
MD1 (b) | script-8-insights.html `insSyncFoldHeads_` | The Agents heading reads "N behind the team · N on track" (the two add up to the judged agents); the slip count is gone.
MD1 (c) | script-8-insights.html `insTrendPill_` | "▲ Improving" or no pill. No "Slipping", no "Steady". The hover text no longer mentions slipping.
MD1 (d) | dashboard.html | Help bullet and help-figure caption describe the single pill. The "Biggest regressors" sort option is KEPT (owner: it only orders the list).
MD1 pins | tests/unit/insights-brief.test.js | The agents rule test rewritten (amber / green, trend ignored); a new test pins the pill (improved only), the heading source, a sweep of script-8 / script-6-ir / dashboard.html for the word outside comments, and that the regressors option stays. All three bite (heading regains a slip count; pill shown for a drop; Team row goes red).
MD1 rendered | tools/ui-harness/drive-smoke.js | Both role shards assert the Agents heading format, that nothing in the region / brief / Agents section reads "slipping", and that no card carries a downward or steady pill.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,166 pass / 0 fail (1 skipped, pre-existing); `npm run lint:gas` clean; module map up to date; INV-16 guard in sync; `npm run ci:ui` all 18 runs passed (run before the driver check was added); drive-smoke admin 113/113 and manager 84/84 with the new check. Regression Scenarios not walked live (needs a deploy): S61's Team step was rewritten and is owner-side.
REGRESSION RISKS: Low. (1) The Team row can no longer be RED, so it will rank lower in the brief than before on a department that used to have a "behind, slipping" agent -- intended. (2) The `data-trend` attribute on each card still carries improved / regressed / mixed (the "Biggest regressors" sort reads the same field); nothing visible uses it. (3) `.ins-trend-down` / `.ins-trend-flat` in styles.html are now unused.
INVARIANTS AT RISK: None. Client presentation only: no server payload, cache key, or aggregation rule changed (no INV-30 bump). INV-53 / INV-26 untouched -- "behind" is still judged on the same manager-excluded team baseline.
NET SCORE: 0 − 0 = 0 (new behaviour by owner ruling; no production fix claimed, no new failure mode found)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard and walk S61 (Team row: amber names "(behind)", green otherwise; cards show "Improving" or no pill) | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- `.ins-trend-down` / `.ins-trend-flat` CSS rules (styles.html) are unused now; left in place because the owner may reintroduce a refined label.
- The card's `data-trend` attribute still exposes the classification in the page source; harmless, kept for the sort.
- An agent who is on par with the team but well down on the prior period now has NO signal anywhere on My Department except the per-card delta figures. That is the owner's ruling; noted so a later "refined slipping" has its starting point.
- Next in the owner's plan: MD2 (Overview "Avg answer time" view), then MD3, MD4.

DOCUMENTATION UPDATES NEEDED:
- None (done in this change: client-ui-conventions ranked-brief rules, S61, next-steps, operator-state #94 wording, fix-history MD1, tests/README).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
