---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: BR-4 (owner 2026-10-29) -- the Insights brief's Agents and Team detail rows merged into one Team row.
New capabilities (G/ST): QV-1 (owner 2026-10-29) -- the DAY QUICK VIEW: a click on a day bar in a My Department team card opens that day in a pop-up (cards for the day beside the range, a condensed agent table, the day's missed calls, workday stepping, "Open this day on the page"); admin-only, released with the day bars.
Files modified: apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-8-insights.html, apps-script/department-dashboard/dashboard.html, apps-script/department-dashboard/styles.html, tests/unit/day-bars.test.js, tests/unit/insights-brief.test.js, tools/ui-harness/drive-dayqv.js (new), tools/ui-harness/drive-smoke.js, tools/ui-harness/ci.mjs, tools/ui-harness/README.md, tests/README.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/regression-scenarios.md, CLAUDE.md

CHANGES:
BR-4 | script-8-insights.html | `INS_BRIEF_TARGET_` entries carry an `ids` list; `agents` = ['ins-agents-fold', 'ins-team-detail'], label "Team"; the `detail` row and its rank slot are gone; the row text is the PURE `insBriefTeamText_` ("<agents verdict> · talk time <ATT> per call"); mount / unmount / apply / restore / `insOpenSection_` (via `insBriefTargetKey_`) walk the list; `INS_BRIEF_MOUNTED_` holds arrays.
BR-4 | styles.html | in a slot holding two sections the second one's `<summary>` stays as a plain, non-clickable sub-heading (no ▸ marker).
BR-4 | insights-brief.test.js, drive-smoke.js | the ranking test without `detail`; a BR-4 test (text + both sections, no detail row); a drive-smoke check that the Team row reads the talk time, opens both sections in order with the sub-heading.
QV-1 | script-5-dept.html | `dqvOpen_` / `dqvShow_` / `dqvClose_`: the cards from `strip.__dts` (PURE `dqvCardFigure_`, tints like the bars; CSR Transfer % from `csrTransfer.daily`) with "Range …" under each; two single-day reads through `dqvFetch_` (join / replay / failure not kept; cleared by `refresh()`) plus outbound through the FO-3 store when `obAllowed_()`; `dqvAgentsHtml_` (LB-2 cells, total row, idle count, dept tag in a combined view); a name opens that agent's day (`apPreDay_`, outbound half cut when `!obAllowed_()`); `dqvMissedHtml_` (CSS half-hour bars, ring times grouped per call with "↳ path", queue hang-ups); arrows + ← / → over `st.bs` (weekends / holidays never a stop; an exception day is, read with `includeExceptionDays` and a note); "Open this day on the page". `dtsWire_`: a mouse click on a DAY bar opens it, a second tap on a held day on touch, Enter / Space on the slider; the idle line invites the click. Gate `dqvActive_()` = `dtsBarsActive_()`.
QV-1 | dashboard.html, styles.html | `#day-qv-modal` (no `[data-admin-only]`: that rule would un-hide it on load) and the `.dqv-*` styles.
QV-1 | day-bars.test.js, drive-dayqv.js, ci.mjs | card-figure + tint unit test; gate / outbound / day-only / single-day-read / Refresh-clear / modal-attribute pins; a new asserting driver (22 checks) wired into ci:ui.

TEST RESULTS: `node --test` 2739 pass / 0 fail (TZ=America/Chicago); `npm run lint:gas` clean; module-deps --check up to date; INV-16 guard in sync; `drive-dayqv.js` 22/22, `drive-smoke.js` 178/178 standalone; full `CI=true TZ=America/Chicago npm run ci:ui` EXIT 0 (all 18 asserting stages; drive-dayqv 22/22, drive-daybars 24/24, drive-smoke 178/178). Bites 6/6: unit -- QV gate, abandon tint, outbound gate, BR-4 text, BR-4 two sections; UI -- a click opening the NEXT day turns 8 drive-dayqv checks red.
REGRESSION RISKS: (1) a click on a day bar used to do nothing on desktop; it now opens a modal -- a user dragging across bars and releasing gets a pop-up (Escape closes; focus returns). (2) Touch: the second tap on a held bar now opens the pop-up instead of staying held. (3) The brief's `INS_BRIEF_TARGET_[k].id` field is gone; any future caller must read `.ids`. (4) A combined-view day table lists crossover agents in each group, as the main table does.
INVARIANTS AT RISK: None -- client-only; no RPC, cache key or payload changed (INV-30 untouched; the pop-up reuses getDepartmentSummary / getMissedCallsReport / getDeptOutboundSummary / getAgentDay with a one-day window, each already capped by SEC-1). INV-53 / INV-05 hold because the table is the server's own summary rows and totals.
NET SCORE: 0 production fixes − 0 new failure modes = 0 (BR-4 is an owner-requested layout change; QV-1 a new capability)

OPERATOR ACTIONS / DEPLOY:
- Walk S61 (the Team row) and S62 (the quick view steps) after the deploy | BLOCKS DEPLOY: N
- Release to managers: later, with the day bars (both gated by `dtsBarsActive_`); the outbound column stays behind `obAllowed_` | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Week / month bars open nothing; a week bar could open its first workday if the owner wants it.
- Stepping stops at the loaded range's ends (the cards come from the page payload); stepping past them would need the summary's own day figures.
- No prefetch of the neighbouring days (each step costs two reads); worth adding only if stepping feels slow in production.
- The pop-up has no route / deep link on purpose (it is a view of the loaded range).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (client-ui-conventions "The DAY QUICK VIEW" + the brief bullet, fix-history BR-4 / QV-1, S61 / S62, tests/README, harness README, CLAUDE.md's asserting-stage count + S62 title).
---END BROAD SCAN IMPLEMENTATION SUMMARY---

---BROAD SCAN IMPLEMENTATION SUMMARY (addendum, 2026-10-29: QV-1b)---
Findings implemented: QV-1b (owner 2026-10-29) -- the day quick view prefetches the workday either side once the open day has landed.
Files modified: apps-script/department-dashboard/script-5-dept.html, tests/unit/day-bars.test.js, tools/ui-harness/drive-dayqv.js, tools/ui-harness/README.md, tests/README.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/regression-scenarios.md
CHANGES:
QV-1b | script-5-dept.html | `dqvPrefetch_(i)` runs once all the open day's reads settle (landed or failed) and only while that day is still on screen; it fetches days i-1 and i+1 (summary + missed, outbound when `obAllowed_()`) through the same join / replay stores; `dqvReq_(b)` is the one request shape; `obSummaryFetch_` takes an optional `store` and the pop-up uses `DQV_OB_STORE_` (cap 18, cleared on Refresh), so stepping no longer evicts the page's own outbound window from the FO-3 store (cap 8).
TEST RESULTS: `node --test` 2740 pass / 0 fail; lint clean; drive-dayqv 24/24 (two new prefetch checks with 2 s held replies). Bites 4/4: unit -- the prefetch call, the own outbound store, neighbours only; UI -- a prefetch that never runs turns 3 drive-dayqv checks red.
REGRESSION RISKS: about twice the single-day reads per day viewed (each read cached 6 h server-side). The page's FO-3 store keeps serving the page's windows; only the pop-up's days moved.
INVARIANTS AT RISK: None (client-only; no RPC, cache key or payload changed).
NET SCORE: 0 − 0 = 0 (a speed-up; the store separation closes a latent eviction QV-1 introduced, which re-read the table's outbound and gave wrong numbers nowhere)
OPERATOR ACTIONS / DEPLOY: deploy the dashboard; walk S62's QV-1b step | BLOCKS DEPLOY: N
FOLLOW-ON ITEMS: fewer requests per day -- one combined single-day endpoint (summary + missed + outbound), optionally taking several dates -- offered to the owner, not built.
---END ADDENDUM---
