---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18 item 3 follow-on | The behind-team classifiers still measured against the dept rate, not the new excluded-manager baseline
- R18 item 2 | A selected window running past the last day WITH DATA was not corrected, and its empty trailing days deflated every per-workday figure

Files modified:
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/script-2-chrome.html
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/styles.html
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md

CHANGES:
Follow-on | script-8-insights.html | THREE sites each pulled `teamStats.pct.val` independently to decide who is "behind the team" -- the headline all-clear chip, the agent-card rail/tier standing, and (server-side) the email block. That is the same shape of drift that let IR and Insights disagree in the first place, so the fix is a single accessor: `insTeamBenchmarkPct_(data)` returns the excluded-manager baseline (`meta.teamAvgBasis.pct`) and falls back to the dept rate for a pre-v21 payload. All three now read it.
Follow-on | script-8-insights.html | `insClassifyAgent_` returns 'steady' for an excluded manager via `insIsExempt_`. Without this a manager on token volume would render as "behind the team" -- the exact opposite of the ruling's intent -- on the card rails even after the benchmark moved.
Follow-on | InsightsReport.gs | `insEmailBehindBlock_` uses the same baseline AND filters `!a.excludedFromTeamAvg`, so the emailed "behind the team average" list and the on-screen cards cannot disagree about who is behind.
R18-2 | script-2-chrome.html | `clampToLatestData_` + `clampDeptToDate_`: a To-date past `latestDqeIso_` is pulled back to it. Applied on BOTH entry points -- the preset chips and a hand-typed date -- and BEFORE the refresh, so the request already carries the corrected window instead of firing twice.
R18-2 | script-2-chrome.html | Two guards worth keeping: the clamp NO-OPS while `latestDqeIso_` is null (that init fetch is async -- clamping against a null would land every user on today), and it pulls `From` back with `To` so a fully-future window cannot invert the range.
R18-2 | dashboard.html + styles.html | `#dept-clamp-note` states the correction ("Adjusted to 2026-08-11 -- data runs through there (2026-08-12 requested)"). Silence would be worse than the original bug: the user picks a range, gets a different one, and every number is right for a window they did not choose.
R18-2 | drive-smoke.js | Three assertions per role on the HAND-TYPED path (the one with no preset to fall back on): the date is clamped to the latest, the correction is stated, and From never ends up after To.

TEST RESULTS: passed. `node --test` 671/671; INV-16 green; claude-md-split + cache-version-sync green; `npm run ci:ui` 62/62 (was 56) + 16/16 + 30/30 + 14/14. Measured against the owner's own scenario in the harness: "This month" now yields Aug 1-Aug 11 and **7 workdays instead of 8** -- the divisor that produced the 273.8/day vs 365/day disagreement.

REGRESSION RISKS:
- The clamp is CLIENT-side only. The server still honors whatever window it is sent, so a deep link / saved view / email link carrying a longer range renders as before -- deliberate: those are explicit requests, and silently narrowing a shared link would be worse than the empty days.
- No cache bump needed: the clamp changes which window is REQUESTED, not how any window is computed. Every cache key already encodes from/to.
- The behind-team change moves classification for depts WITH excludes only; with none configured `insTeamBenchmarkPct_` returns the dept rate exactly as before (the Phase 2 no-op test pins basis == rollup in that case).
- `insClassifyAgent_`'s exempt short-circuit returns 'steady', which is the neutral rail -- an excluded manager keeps a card and its metrics, it simply carries no peer verdict.

INVARIANTS AT RISK: None. INV-43 (the From/To default snaps to the most recent DQE date) is REINFORCED -- the clamp extends the same "land on real data" principle to presets and typed dates. INV-35's working-day math is untouched; it now just receives a window that matches the data. INV-26's scope ruling (documented in Phase 2) now holds across all four classification surfaces rather than two.

NET SCORE: 2 production fixes − 0 new failure modes = 2
(Both fired in production: the per-day pace was wrong on any window reaching past the last import -- which "This month" does every day until the month's data catches up -- and the behind-team lists were measured against a manager-diluted rate.)

OPERATOR ACTIONS / DEPLOY:
- None new. The Phase 2 action still stands: populate Dept Config "Team Avg Excludes" for other depts with a call-taking manager on the roster | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Remaining owner items: dark-mode gap-chart zero baseline (4a -- hypothesis is THEME captured under the light palette and not repainted on the mode flip; needs a canvas-pixel probe to confirm before claiming a fix) and Calendar for the Queue: Abandoned % metric (8 -- needs a YTD queue daily series, which unlike the team YTD is a genuinely bigger QCD read, so it is a cost decision rather than an oversight).
- The clamp does not cover report surfaces reached by deep link with an explicit range (see the regression note) -- intentional, but worth revisiting if a stale shared link ever confuses someone.

DOCUMENTATION UPDATES NEEDED:
- DONE: docs/client-ui-conventions.md gained the clamp rule with its two guards and the measured divisor symptom.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
