---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: IXT-1 (owner 2026-10-27) -- Caller Lookup (and every journey drill) stopped at the agent who answered when that agent transferred or consulted a COLLEAGUE: 8x8 logs each attempt as a separate internal call and the inbound capture dropped them (R11-N follows queue transfers only). The capture now appends them to the caller's journey, journey-only: (1) the Transfer To Call ID target -- the consult as its own event and the colleague taking the caller; (2) every other internal dial from the answering agent's extension while live on the call, keyed on the CALLER (any callee, each its own event: no answer / voicemail or an answered consult), unique captured call only; (3) recording legs removed from every journey. Plus the read-only `diagnosePersonTransfers`.
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/department-dashboard/AgentHome.gs, apps-script/department-dashboard/script-10-escalations.html, tests/unit/inbound-calls.test.js, tests/unit/agent-home.test.js, tests/unit/client-correctness.test.js, tests/README.md, CLAUDE.md, docs/operator-state.md, docs/per-call-capture.md, docs/fix-history.md, docs/regression-scenarios.md

CHANGES:
IXT-1 (1)(2) | inboundCalls.js | `IC_COL.TRANSFER_TO` = 15; new `icPersonTransferEnrich_(groups, recordByRoot, agentBusy, stats)` run at the end of `buildInboundCallRecords_` (after R11-N / the internal-record pass): col-P target -> captured call map (a call naming itself or a target named by two calls is skipped); per non-captured group without an Incoming or queue leg, `icIxtGroupEvents_` builds consult (`kind:answer`, `consult:true`, talk capped at the hand-over), missed attempt (`kind:leg`, `missed`, `secs`, `voicemail`) and hand-over (`kind:answer`, `handover:true`, the receiving rep's Outgoing leg to the caller's number) events from DIAL legs only (both ends bare extensions); timing groups attach via `icConcurrentMatches_` + `icDistinctRoots_` (exactly one captured call), and a group touching an outside number is left out; `icMergeJourneyEvents_` merges by time under the 40-event cap. Every added event carries `transfer:true`. `opts.ixtStats` returns linked / timing / ambiguous / outsideSkipped / calls / attemptsPerCall / samples.
IXT-1 (3) | inboundCalls.js | `icIsRecordingLeg_`: `icBuildJourney_` skips `CallRecording...` callee legs (the "(unknown) 0:08:58" row).
IXT-1 diagnostic | inboundCalls.js | `diagnosePersonTransfers(dateIso)` over the held Call_Legs_* tabs (blank = latest, 'all'), per-date + total lines, 1 / 2 / 3+ attempt distribution, samples (call ids only); PURE fold `icIxtFoldStats_`. Writes nothing.
IXT-1 | AgentHome.gs | `ahWaitJoin_` skips `transfer:true` events -- the one journey reader that did not, so a colleague's consult attempt can never read as that colleague's missed queue ring. (The journey-end / queue-wait SQL, Agent Day's role and the transfer tally already skipped them.)
IXT-1 | script-10-escalations.html | Journey rows label `voicemail` ("went to voicemail"), `consult` ("consult with the agent"), `handover` ("took the caller"); the chain skips the consult token. "Call ended" now lands at the hand-over's end via the existing end-row rule.
IXT-1 | tests | inbound-calls +8 (the owner's 10/26 legs end to end with journey-only fields pinned unchanged, the recording filter, a second attempt to another teammate, an unlinked consult + a late attempt, the ambiguous agent, outside-number / queue groups, a self link, the fold), agent-home +1, client-correctness +1; tests/README map.
IXT-1 | docs | Operator State #84 (+ CLAUDE.md index), per-call-capture R11-N note, fix-history IXT-1, S38 step.

TEST RESULTS: `node --test` 2699 pass / 0 fail (TZ=America/Chicago); lint:gas clean (78 files); INV-16 guard clean; module-deps --check up to date; ci:ui -- see the run recorded in STATE. Bite-checks 10/11 bite: Transfer To link, consult capped at the hand-over, every timing attempt attached, ambiguous skip, outside-number skip, recording filter, transfer flag, agent-app skip, chain skips the consult (+1 retry of the attempts pin). The self-link guard does NOT bite: a captured call is skipped before the link is consulted, so the self-link test passes on that skip alone -- the guard is belt-and-braces, not load-bearing.
REGRESSION RISKS: (1) A timing-only attempt can be unrelated to the caller (the agent rang a colleague about something else while the customer was on hold) -- it shows as a consult attempt on that call; unique-match + caller-keyed + only-while-live bound it, and it never moves a figure. (2) Removing recording legs changes the journey-end the S2C-2 transfer tally computes only if a recording outlasted every real leg (recordings end with the call they record). (3) Not retroactive: stored journeys keep the old shape until `backfillInboundCalls(.., true)` + the Inbound Calls export. (4) More events per journey: a long call nearer the 40-event cap drops added events, never original ones.
INVARIANTS AT RISK: INV-01 (no public write), INV-53 / INV-04 (no figure or name match changed -- added events are transfer:true and skipped by every metric reader; pinned for the agent app). None violated.
NET SCORE: 1 production fix (the owner's call showed no transfer this week) − 1 new failure mode (a timing-only consult attempt can belong to another matter) = 0

OPERATOR ACTIONS / DEPLOY:
- After both pushes: `backfillInboundCalls(from, to, true)` over the held dates, then the Inbound Calls tab export (#49) | BLOCKS DEPLOY: N
- Run `diagnosePersonTransfers('all')` and send the log; check 1783985478661 (10/26) in Caller Lookup per S38 | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`
Deploy: Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version → Deploy

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Nash's Agent Day does not list a call he took by transfer (added events are skipped there on purpose); a "received a transfer" row would be its own change.
- The self-link guard in icPersonTransferEnrich_ is redundant with the captured-call skip.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
