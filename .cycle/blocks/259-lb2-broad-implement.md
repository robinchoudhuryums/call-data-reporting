---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- LB-2 -- the My Department combined (inbound + outbound) agent table, Option B of the owner-approved mock: ONE line per agent; an inbound bar column (answered / missed) and an outbound bar column (connected / rang out / brief ring / not recorded), each on its own scale, counts + per-day pace beside each bar; Ans % and Conn % carry the change chips (inbound rate chip new), count changes move into each bar's hover; Talk shows both directions and sorts by their sum; every header sorts by click / keyboard; a group row names each direction with its colour key.
New capabilities (G/ST): None
Files modified: apps-script/department-dashboard/{script-5-dept.html, styles.html}; tools/ui-harness/{drive-deptoutbound.js, README.md}; tests/unit/overview-outbound.test.js; docs/{client-ui-conventions.md, fix-history.md, regression-scenarios.md}

CHANGES:
LB-2 | script-5 obViewRender_ | new obInCellHtml_ / obOutCellHtml_ / obOutParts_ / obInRateChip_ / obTalkCellHtml_ / obLegendHtml_ / obSignedDelta_; layout B's obThPairHtml_ / obPairCells_ and the now-unused obBarHtml_ removed; obSortList_ gains talkAll.
LB-2 | styles.html | layout B rules replaced by the .lb-* rules and the outbound segment colours (.ob-seg-oconn / -oreal / -obrief, .ob-seg-misslite for the R10-4 passing row).

TEST RESULTS: node --test 2734 pass / 0 fail (TZ=America/Chicago); lint:gas clean; module-deps up to date; `CI=true npm run ci:ui` exit 0, no FAIL (drive-deptoutbound 49/49). Bites: 5/5 UI (shared scale, out bar drops brief, a count chip back on the bar, talk sort ignoring inbound, no per-day under inbound) + 1/1 unit (a chip call in the outbound cell).
REGRESSION RISKS: the inbound-only table (columns off) is untouched; exports still produce the inbound table; the row is still one <tr> per agent so the agent panel and subtotals keep working (drive-deptoutbound + drive-agentpanel pass). Batch F's count chips are gone from the rows by owner ruling (now hover text).
INVARIANTS AT RISK: INV-53 (floaters) -- unchanged, rows come from the same state.rows / outbound payload; INV-05 untouched (ATT not shown here).
NET SCORE: 0 - 0 = 0 (presentation change; counted as capability)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version (or scripts/deploy.sh .)

FOLLOW-ON ITEMS:
- None

DOCUMENTATION UPDATES NEEDED:
- None (client-ui-conventions LB-2 paragraph, fix-history LB-2, S57, harness README done).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
