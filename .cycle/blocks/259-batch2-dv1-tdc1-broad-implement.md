---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- TDC-1: the Team Direct Calls side card showed only "loading…" text and looked unlike its neighbours -- now a panel like Team Rings / Team Outbound with a skeleton, an error + Retry and a per-agent tally
- AT-1: the agent table's standing explainer (Connected, the off-roster dialler count, exports stay inbound) moved from a note over the table to an ⓘ beside the title
New capabilities (G/ST):
- DV-1: the My Department direction switch is segmented with four admin-only views -- Inbound, Outbound (outbound-only table), Inbound + outbound (default), Direct (the Direct Calls report's per-agent rows)
Files modified:
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-5-dept.html
- apps-script/department-dashboard/script-10-escalations.html
- apps-script/department-dashboard/styles.html
- tests/unit/brief-accordion.test.js, tests/unit/client-dead-ends.test.js
- tools/ui-harness/drive-deptoutbound.js, drive-callbacks.js, drive-crossstate.js, drive-outbound-e.js, tools/ui-harness/README.md
- docs/client-ui-conventions.md, docs/regression-scenarios.md (S46, S57, the S67 D3 step), docs/operator-state.md (#63), docs/fix-history.md, tests/README.md, CLAUDE.md (S57 index title)

CHANGES:
DV-1 | dashboard.html, script-5-dept.html, script-10-escalations.html, styles.html | #dept-dir-switch = four [data-dir-pick] buttons; OB_DIRS_ + obSetDir_; obViewRender_ outOnly mode (Agent / Connected / not / Conn % / Talk, no Transfer %); dcViewRender_ (#agents-dc-table) from TDC_ with sortable headers and the agent panel; body[data-dir] hides the inbound table off 'in' and Team Rings on out / direct; apTbody_ follows the view; the Direct button keeps its own data-admin-only and obEffectiveDir_ drops 'direct' to 'both' unless tdcActive_()
TDC-1 | dashboard.html, script-5-dept.html, styles.html | #dept-team-direct is a div panel loaded with the page (tdcSync_ -> tdcFetch_, once per dept + window), #tdc-loading skeleton + aria-busy, #tdc-error with #tdc-retry, a tally per agent (answered / missed / busy) and legend, rows -> tdcJump_ (the Direct view at that agent); ONE getDirectCallReport shared with DV-1's view
AT-1 | dashboard.html, script-5-dept.html | #dqe-table-info ⓘ (obInfoSync_) carries Connected / off-roster count / exports-stay-inbound (out, both) and Direct's busy rule (direct); hidden on Inbound; Neon-down / capture-start / data-gap notes stay visible, and the note box hides when empty

TEST RESULTS: node --test 2791 pass / 0 fail (TZ=America/Chicago); lint:gas clean; module-deps --check clean; bites 5/5 (out dropped from saved views, Direct view sends its own RPC, Team Direct lazy again, Connected note visible again, agent panel ignores the Direct table); drive-deptoutbound.js all PASS standalone; ci:ui see STATE
REGRESSION RISKS:
- Team Direct Calls now fetches getDirectCallReport on every admin My Department load (it was on open only): one extra admin-only RPC per dept + window, served from the report's 6 h cache after the first
- A browser that saved 'out' before Step 3 now lands on the Outbound view instead of together (it was mapped to 'both' since Step 3)
- "Show all columns" / "Compact rows" still sit beside the switch on every view though they affect the inbound table only (unchanged from the Both view)
INVARIANTS AT RISK:
- INV-39 / the 6c release (Operator State #63): the Direct button carries its own admin gate so releasing #dept-dir-switch cannot expose the still-vetted Direct report; pinned in brief-accordion.test.js
- INV-53: the Direct view shows the Direct Calls report's own agent rows (its own roster rules), not the inbound table's
NET SCORE: 2 production fixes (TDC-1, AT-1) − 0 new failure modes = 2

OPERATOR ACTIONS / DEPLOY:
- None (client-only; no property, trigger or migration) | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version

FOLLOW-ON ITEMS:
- Batch 3 (IC-1..IC-4): Callbacks / Direct lines ⓘ tooltips, side-by-side list buttons, the Direct lines expand arrow, the brief rows' drawer animation, the same on the Overview's sections
- Batch 4: TR-1 after the TR-0 numbers
- "Show all columns" / "Compact rows" could hide off the Inbound view (not asked)
- The agent panel's hover prefetch (apPrefetchWire_) does not listen on the Direct table (an optimisation only)

DOCUMENTATION UPDATES NEEDED:
- None beyond those made
---END BROAD SCAN IMPLEMENTATION SUMMARY---
