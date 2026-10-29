---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: HOH-0b (owner's first HOH-0 run, 2026-10-29) -- the hold-hangup diagnostic follows a warm transfer into the Transfer To call; XB-0b (first XB-0 run) -- the bounce diagnostic places two-roster answerers and shows its coverage.
New capabilities (G/ST): None (read-only research tools sizing HOH-1 / XB-1)
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/transferFilter.js, tests/unit/inbound-calls.test.js, tests/unit/transfer-filter.test.js, docs/operator-state.md (#85, #86), docs/fix-history.md, docs/per-call-capture.md, tests/README.md

CHANGES:
HOH-0b | inboundCalls.js | `icHoldHangupShape_(legs, opts)` takes `opts.linked` (legs of the calls reachable via col P) + `opts.callerNumber`; a linked hand-over leg (Outgoing to / Incoming from the caller's number, never a colleague-to-colleague consult) outlasting the flag decides answeredAfter / unansweredAfter; new `icHoldHangupLinkedLegs_` (col P, chained IC_HOH_LINK_DEPTH_ = 3 hops, no loops); the shape adds viaLink / linked / flaggedLegTransferTo / flaggedLegCauseTransfer (IC_COL.CAUSE = 26); the fold, TOTAL and the line carry them.
XB-0b | transferFilter.js | `tfBounceOfJourney_`: a two-roster answerer goes to the department of the queue that just rang them when it is one of theirs (the ring is consumed by an answer), else stays in the current stint's department when it is one of theirs, else is skipped; `resolved {byQueue, byStint}`, `unknownAgents` (a 7+-digit name as "(a number)"); the fold adds callsWithSkip; the line adds both placements and calls still skipping a step; the log lists off-roster answerers.

TEST RESULTS: `TZ=America/Chicago node --test` 2753 pass / 0 fail (+5); lint:gas clean; module-deps up to date; INV-16 guard in sync. Bites 6/6 (the col P link, the hand-over-only rule, the loop guard, the ringing-queue placement, the ring consumed by an answer, the number mask). ci:ui not run: no client, dashboard or payload file changed.
REGRESSION RISKS: None for figures -- both are editor-run and read-only; the capture builder is called, not changed. The first runs' numbers are superseded: HOH-0's 135/135 `final` is void; XB-0's 3 bounces was a floor.
INVARIANTS AT RISK: None -- no write path, no public endpoint, no capture change; logs carry call ids, employee and queue names only.
NET SCORE: 1 − 0 = 1 (HOH-0b fixes a diagnostic whose first production run gave a wrong answer)

OPERATOR ACTIONS / DEPLOY:
- Push cdr-import, re-run `diagnoseHoldHangupsAllDates` and `diagnoseTransferBouncesAllDates`, send both logs | BLOCKS DEPLOY: N
- Give each "queue not placed" a Dept Config row or name its owning department (UDC_A_Q_Main, A_Q_PAP, A_Q_AfterHours, A_Q_Sales_MWC, A_Q_Spanish, A_Q_PAK, A_Q_BackUp_FieldOps, UUC_A_Q_Main) -- the sub-queues ride only the dashboard's seed constants, which cdr-import cannot read | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- HOH-1 / XB-1 wait on the re-runs.
- The capture's own `abandoned_on_hold` has the same blind spot HOH-0 had (any caller leg's flag, no col P look); HOH-1 is where that is decided, not here.

DOCUMENTATION UPDATES NEEDED:
- None (Operator State #85 / #86, fix-history HOH-0b / XB-0b, per-call-capture's col P note, tests/README updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
