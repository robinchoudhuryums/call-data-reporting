---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18b item 1 | Email tally at 5 calls/block is too coarse where most queues live; and the WEB all-departments report still used the retired per-section unit
- R18b item 2 | The per-agent missed-call cards dominate the page with no way to collapse them
- R18b item 3 | The side-panel column grew its own scrollbar for depts with sub-queues or large rosters
- R18b item 4 | The cross-link spotlight scrolled the agent card under the sticky controls strip

Files modified:
- apps-script/department-dashboard/QueueReportEmail.gs
- apps-script/department-dashboard/script-1-core.html
- apps-script/department-dashboard/script-4-nav.html
- apps-script/department-dashboard/script-5-dept.html
- apps-script/department-dashboard/script-9-inbound-direct.html
- apps-script/department-dashboard/script-10-escalations.html
- apps-script/department-dashboard/script-11-qcd-boot.html
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/styles.html
- tests/unit/queue-report.test.js
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md

CHANGES:
item 1 | QueueReportEmail.gs | The unit now PREFERS 2 calls/block. R18's adaptive basis landed on 5 for a typical day, which is coarse exactly where most queues live -- an 11-call queue and a 13-call one drew the same length. The adaptive ladder is kept as a FALLBACK rather than deleted, because clipping is only honest while it is RARE: once a large share of rows sit at the ceiling they all draw the same length and the tally ranks nothing. So 2 wins only when it would clip at most a quarter of the rows, tested as a STRICT minority with no floor -- a report of two or three queues may not clip at all, since one of two rows at the ceiling is not "rare", it is half the report.
item 1 | QueueReportEmail.gs | `tallyClipped` is recomputed from the unit actually chosen rather than reusing `tallyScale.clipped`, which counts outliers dropped from the BASIS and is only equal when the basis-derived unit won. The `»` legend gates on it, so it can never explain a mark that is not on screen.
item 1 | script-11-qcd-boot + script-10-escalations | The WEB all-departments report gets the same one-unit scale, which R18 had deliberately deferred. That deferral reasoned the web report is one scrollable page where the Total column sits beside every bar -- but the misread is the same in either medium, and the owner reported it. The unit is computed ONCE before the section loop from every queue row the table will draw; the per-dept `.qcd-deptrow-unit` note is gone and a single `.qcd-tally-legend` sits under the company row. `qcdDailyBarCell_` gained `opts.tallyMax`: a shared-scale caller MUST be able to clip, since a fine unit is what makes the small queues separable and without a ceiling the busiest queue wraps into a block of colour that dwarfs the table. Callers with a per-cohort unit pass no max and are byte-unchanged.
item 1 | script-1-core | `ansTallyBlocks_` gained a sibling `ansTallyBlocksN_` taking an already-resolved block COUNT. A caller that clips has to decide the count before emitting, so it cannot go through the value+unit form; the old function now delegates, so there is still one emitter.
item 2 | dashboard.html + script-5-dept | The per-agent cards moved into `#dept-missed-agents-fold`, CLOSED by default and remembered per user (`cdr.dept.missedagents`). The agent COUNT rides the summary: a collapsed section that does not say how much it hides gives no reason to open it. The R17h cross-link still reaches a card inside the fold, because `deptMissedJumpToAgent_` already opens the whole `<details>` chain before spotlighting.
item 2 | script-1-core + styles | `waveIn_(container, selector)` staggers a grid so it arrives top-left -> bottom-right. The rank is MEASURED from each element's position inside its container, never derived from its index -- both callers' grids reflow with the viewport, so an index diagonal would be right at one width and meaningless at another. It skips entirely under `prefers-reduced-motion`, caps the stagger so a big grid still feels prompt, uses `both` fill so an element whose animation never runs still ends VISIBLE rather than stranded at opacity 0, and removes the class on `animationend` so a re-open cannot inherit a stale delay.
item 2 | script-9-inbound-direct | The abandon heatmap waves its cells on render, the same helper, per the owner's ask.
item 3 | styles.html | The sticky aside is a bounded flex COLUMN now. Panel 1 keeps its natural height (a fixed set of tiles); panel 2's agent table -- the only genuinely unbounded part, since it grows with team size -- absorbs what is left, with a floor of ~4 rows. `overflow: auto` stays as the last resort for a viewport too short even for that floor, where a scrollbar is the correct answer. Measured at 1440x900 and 1440x760: the column's own scroll is 0 in both, and the table shrinks 223px -> 134px to make that true.
item 4 | script-4-nav | `qsSpotlight_` scrolls through the new `scrollFullyIntoView_` instead of `scrollIntoView({block:'start'})`, which put the target's top at the VIEWPORT top -- underneath the pinned controls strip -- so the very card it was drawing attention to was the part that got covered. The sticky inset is read from each candidate's RESOLVED `top` + height rather than its current position, because the scroll being computed is the one that pins it. It moves the minimum distance and never pushes the top back under the strip when the element is taller than the space.

TEST RESULTS: passed. `node --test` 674/674 (+1 tally test: the preferred unit plus its fallback); INV-16 green; `npm run ci:ui` drive-smoke 80 (was 74) + f13 + subqueue + devoverlay. Live-probed each item rather than trusting the diff: the email re-rendered at 2 calls/block with only CSR clipping; the web report's blocks measured monotonic in volume with one legend and no per-dept note; the fold measured closed-by-default, waved with distinct ranks, settled with no stuck class and no card left invisible, and survived a reload; the aside measured zero column scroll at two viewport heights; the spotlight measured top=802 against a 177px inset.

REGRESSION RISKS:
- The preferred unit makes clipping MORE common in the email by design. The fallback bounds it, but a day whose volume spreads differently than expected will look different from the day before -- that is inherent to any adaptive scale, and the legend states the unit every time.
- `ansTallyBlocks_` now delegates to `ansTallyBlocksN_`. Byte-identical output for every existing caller (same rounding, same min-1 floor), but it is a shared helper with several callers, so the delegation is the thing to check first if a tally ever renders wrong.
- The wave runs on every heatmap render, not only on fold-open. Cheap (a rect read per cell) and reduced-motion-aware, but it is the one place the animation fires without a user gesture.
- The agent-card fold defaults CLOSED, which changes what a manager sees on first load after deploy. Deliberate per the owner; the count on the summary is what keeps it discoverable.

INVARIANTS AT RISK: None. INV-18's chart band and the missed-report semantics are untouched -- this round is presentation only. The R16e block-ceiling constraint now holds on the web report too, by the same clipping mechanism the email uses.

NET SCORE: 4 production fixes − 0 new failure modes = 4

OPERATOR ACTIONS / DEPLOY:
- None new. The Phase 2 action still stands: populate Dept Config "Team Avg Excludes" for other depts with a call-taking manager on the roster | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The heatmap wave could not be verified in the harness: `getInboundHeatmap` is deliberately unmocked (the panel must hide silently on failure, which is itself part of the audit), so the heatmap never renders there. The code path is shared with the card wave, which IS verified, but the heatmap half is confirmed only by reading.
- The email and the web report now implement the same scale rule in two languages (`tallyBasisFor_` in .gs, the IIFE block in script-11). They agree today and are pinned on both sides, but a third surface would be the moment to extract one shared description of the rule.

DOCUMENTATION UPDATES NEEDED:
- DONE: docs/client-ui-conventions.md — the Daily Call Queue Report bullet carries the preferred unit, its minority-clip guard and the web-report port (superseding the "not yet revisited" note R18 left); a new bullet covers the wave's measured-rank rule, the card fold, and why a spotlight has to stop short of the sticky strip.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
