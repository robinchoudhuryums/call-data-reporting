---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: NX-2 (owner 2026-10-30) -- a CallRecording leg 8x8 marks Incoming is not a caller, so short outbound calls stop reading as inbound calls answered in a second, and the outbound capture stops dropping them.
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/outboundCalls.js, tests/unit/outbound-calls.test.js, tests/README.md, docs/operator-state.md (#87), docs/fix-history.md, docs/per-call-capture.md, CLAUDE.md (#87 index line)

CHANGES:
NX-2 | inboundCalls.js | PURE `icIsCallerIncoming_(leg)` = Direction Incoming AND not `icIsRecordingLeg_`; used by the record's `incoming` legs (buildInboundCallRecords_), the outbound-busy index (icBusyIndexes_), the IXT enrichment's "is this group inbound?" skip and NX-0b's outbound index.
NX-2 | outboundCalls.js | Gate 1, the inbound-root map behind the busy indexes, and the OBX diagnostic's hasIncoming map use the same helper.

TEST RESULTS: `TZ=America/Chicago node --test` 2770 pass / 0 fail (+3, on the owner's own two 10/19 legs, number disguised); lint:gas clean; module-deps up to date; INV-16 guard in sync. Bites 4/4 (the helper, the inbound filter, outbound Gate 1, the busy index). No client file changed, so ci:ui not run locally (CI runs it).
REGRESSION RISKS: (1) Inbound counts fall ~2% (~26 calls a day, nearly all "answered" in 1-5 s) and outbound counts rise by the same calls, on dates captured after the push; held dates change only when backfilled. (2) An inbound group whose ONLY Incoming leg is a recording leg and that touches a queue would now take the internal-origin path -- not seen in the data (recording legs follow an answer). (3) Two older editor-only previews (inboundCalls.js ~2110 / ~2297) keep their bare Incoming test; they are research tools and read the same legs either way for real inbound calls.
INVARIANTS AT RISK: None -- no dashboard reader, cache key or payload shape changed; the change is which group each capture claims.
NET SCORE: 1 − 0 = 1 (fires daily: ~26 calls a day were filed in the wrong direction)

OPERATOR ACTIONS / DEPLOY:
- After the cdr-import push: `backfillInboundCalls(from, to, true)` and `backfillOutboundCalls(from, to, true)` over the held Call_Legs dates (as for IXT-1 / OBX-1); the export triggers (#49 / #50) refresh the sheet copies | BLOCKS DEPLOY: N
- Optional: re-run `diagnoseOutsideNumberLegsAllDates` -- the "only record of talk" group should fall to the handful of real ones | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Inbound report and Overview will show the ~2% drop from the push date on; worth a one-line note to managers if anyone compares weeks across it.
- XB-1 still waits on the Dept Config rows (PAP / Spanish / PAK / MWC / BackUp_FieldOps) and a bounce re-run.

DOCUMENTATION UPDATES NEEDED:
- None (Operator State #87, CLAUDE.md #87, fix-history NX-2, per-call-capture's direction rule, tests/README updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
