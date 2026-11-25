---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F2 (filed VS-1) — the queue-split fail-open verdict is taken on the window a surface SHOWS, not the whole fetch (My Department, IR, Insights, the agent app)
- F38 (filed TT-1) — the DQE build and its drill credit the agent's own Outgoing top-level talk leg (the S2C-1 shape) as a FALLBACK where the callee rule found no talk; the leg-shape probe says whether live data reaches it
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/Data.gs, InsightsReport.gs, IndividualReport.gs, AgentHome.gs, CacheWarm.gs (comment), OrphanFix.gs (comment)
- apps-script/cdr-import/buildDQEHistoricalData.js, apps-script/cdr-report/buildDQEHistoricalData.js (INV-16 pair, byte-identical)
- apps-script/cdr-report/DQEdrilldown.js
- apps-script/cdr-import/inboundCalls.js (callLegShapeTally_ / previewCallLegShapes)
- tests/unit/manager-numbers.test.js, dqe-drilldown-parity.test.js, inbound-calls.test.js, compute-summary.test.js (version token); tests/harness/parityDay.js (rawRow sets CALLER_NAME)
- CLAUDE.md, docs/invariants.md (INV-08, INV-30), docs/fix-history.md (VS-1, TT-1), docs/known-issues.md + docs/conventions.md (version tables), docs/operator-state.md, docs/architecture.md, docs/client-ui-conventions.md (version tokens)

Fix codes: scan F2 / F38 are filed as VS-1 / TT-1 -- bare `F#` collides with the Neon `F#` family twice already (fix-history `F2` rows), the NUM- / RB- precedent.

CHANGES:
F2 / VS-1 | Data.gs computeSummary_, InsightsReport.gs computeInsights_, IndividualReport.gs computeIndividualReport_, AgentHome.gs getAgentHome | `applyQueueSplitToRows_` gets `verdictFromIso: from`. With split evidence in the shown window, that window decides; with none, every row decides as before (an idle window still narrows to zero). `getAgentHistory` (AgentHome ~574) left alone on purpose: its 12-month fetch IS what it shows. Cache bumps summary:v27->v28, individual:v14->v15, insights:v30->v31, agentHome:v1->v2 (INV-30, the NUM-4 precedent), every doc token + both version tables updated.
F38 / TT-1 | buildDQEHistoricalData.js (both copies), DQEdrilldown.js | Pass 1 keeps each top-level leg's canonical CALLER_NAME and whether CALLER / CALLEE are external (>= 10 digits). `findAgentTalkOnParent`: unchanged callee rule first; only if it found no talk, the max talk of a leg with an external CALLEE, internal CALLER, and CALLER_NAME == the agent. No previously non-zero figure can move. The drill mirrors it line for line.
F38 / TT-1 | inboundCalls.js callLegShapeTally_ + previewCallLegShapes | New count `onlyExternalCalleeTopLevelNamed` and a printed "DQE talk (TT-1)" line with a verdict (all / partly / none reached / no such calls). Counts only.
Tests | manager-numbers.test.js | VS-1 behavioural pin through the REAL computeSummary_ (a prior-window old-name row no longer zeroes the shown day) + a source pin on the four call sites. Bite-checked: reverting Data.gs fails both.
Tests | dqe-drilldown-parity.test.js | TT-1: S2C-1 parent (600 s credited), a decoy where Anna has a callee leg (60 s) AND a 900 s outside leg (only 60 s counts), an external-both-ends leg (never credited); the drill's TTT and per-parent talk equal the build's. Bite-checked: reverting the build fails both, reverting the drill fails the drill test.
Tests | inbound-calls.test.js | the probe counts a top-level named leg (1), a child leg (0), an unnamed leg (0); output stays counts-only.

TEST RESULTS: passed -- `node --test` (TZ=America/Chicago) 3,201 tests, 3,200 pass, 0 fail, 1 skipped; `check-duplicated-files.sh` clean; `npm run lint:gas` clean (82 files); `module-deps.mjs --check` up to date. `npm run ci:ui` NOT run: no client file changed and no payload shape changed (values only).
Regression scenarios: S1, S6, S14, S35, S37 (VS-1) and S5, S7 (TT-1) -- NOT APPLICABLE here (they need the live deployment); walk after deploy.

REGRESSION RISKS:
- VS-1: a window whose split evidence does NOT match but whose prior/trend does now falls open -- ALL its rows (prior included) show all-queue figures, so the prior chips compare all-queue with all-queue (consistent). The reverse case (shown window matches, prior does not) narrows the prior to zero exactly as before -- not made worse, not fixed (FO-261-1).
- VS-1: four cache prefixes miss cold for the first loads after deploy (expected; CacheWarm re-warms).
- TT-1: on a date re-imported after deploy, TTT rises and ATT moves for agents with S2C-1 calls IF the leg is top-level; the queue split (col AI) and after-hours talk (AK) use the same lookup, so the split still sums back to the rollup.
- TT-1: a top-level Outgoing leg from the agent to an outside number on a parent where the agent has no callee-named talk leg is now credited even if it was a consult rather than the customer conversation (see REFLECT).

INVARIANTS AT RISK:
- INV-08 — extended, not violated: own-talk attribution keeps its rule; the fallback reads the agent's OWN leg, never parent.talkSec. Entry updated.
- INV-16 — both build copies edited together; guard passes.
- INV-30 — four prefixes bumped; cache-version-sync green.
- INV-05 / INV-25 — ATT formulas unchanged; only their inputs (credited parents) can grow under TT-1.
None violated.

REFLECT:
- VS-1: (a) fired this month? NO -- live-reachable under QUEUE_SPLIT_SCOPE=dept, but no queue rename was reported. (b) new failure mode? NO.
- TT-1: (a) fired this month? NO as far as can be shown -- the test fixtures model the S2C-1 leg as a CHILD leg, which the build's parent map never holds, so the fix may reach no live call; the probe decides. (b) new failure mode? YES (Low) -- an agent's top-level outside call on a parent with no callee-named talk leg is credited as talk.
Tally: 0 production fixes − 1 new failure mode = −1.

NET SCORE: 0 − 1 = −1

OPERATOR ACTIONS / DEPLOY:
- Run `previewCallLegShapes()` in the CDR Import editor on a recent date (or CDR Tools menu) and read the "DQE talk (TT-1)" line. Only on "all reached" / "partly reached", re-import the dates you report on (Operator State #56). On "none reached", report it -- the fix is inert and the real attribution needs the child-leg shape (FO-261-2). | BLOCKS DEPLOY: N
- After the dashboard deploy: `runLiveSmoke`, then walk S1, S6, S14, S35, S37. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version)
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
(Not complete in production until the three pushes are confirmed; TT-1 changes no stored row until a date is rebuilt.)

FOLLOW-ON ITEMS:
- FO-261-1 | Data.gs computeSummary_ (+ IR / Insights): the prior / trend window still takes the CURRENT window's queue-split verdict, so a mapping that changed mid-span narrows the prior to zero; a per-window verdict needs one pass per window | → next audit
- FO-261-2 | cdr-import buildDQEHistoricalData.js TT-1: whether the S2C-1 talk leg is top-level in live data is unverified; if `previewCallLegShapes` says "none reached", the build must read the child leg instead (a larger change to the parent map) | → decision (owner runs the probe and reports the TT-1 line)

DOCUMENTATION UPDATES NEEDED:
- None beyond those made (CLAUDE.md queue-split bullet, INV-08, INV-30 + both version tables, fix-history VS-1 / TT-1). /sync-docs may want an Operator State #56 sentence pointing at the TT-1 probe line.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
