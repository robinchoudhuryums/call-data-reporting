---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- WS-1 (Batch 8 follow-on, owner option 1): an internal call's wait_seconds starts at the requester's queue leg, not the earliest leg under the call id
- WS-1 verification tool (owner ask): previewInternalWaitStart, a read-only before/after comparison
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/CDR Tools.js, tests/unit/inbound-calls.test.js, docs/operator-state.md (#75), docs/per-call-capture.md, CLAUDE.md (Operator State index line 75)

CHANGES:
WS-1 | inboundCalls.js | `waitStart` = the originator queue leg's START on internal-origin records (fallback: firstStart). waitSeconds is measured from it. call_start, call_date and _startMs (the related-call cross-ref) keep firstStart. External records are untouched.
WS-1 tool | inboundCalls.js, CDR Tools.js | buildInboundCallRecords_(rows, {waitDiag:true}) keeps scratch fields `_waitFirstLeg` (the old wait) and the labels of both start legs; the capture never passes it. New icWaitLegLabel_ masks external parties. previewInternalWaitStart(date | 'all' | blank = latest):
- classifies each internal record UNCHANGED / CHANGED / SUSPECT (new > old or a blank mismatch -- impossible by construction);
- counts external records whose wait would change (must be 0);
- best-effort reads what Neon stores (old / NEW / neither);
- logs CHANGED rows largest cut first, capped at 200;
- returns the object.
Two menu items under CDR Tools → Diagnostics.

TEST RESULTS: passed. 2391 tests, 2390 pass, 0 fail (1 skipped, pre-existing). The PIPE-13 test's wait changed 60 → 40, since it encoded the old start. 3 new WS-1 tests. Lint clean, module-deps current, INV-16 in sync. All 5 bites fail a test as they should (the start rule, callee masking, caller masking, Neon labelling, the UNCHANGED classification).
REGRESSION RISKS: internal-record wait_seconds shrinks wherever a colleague's leg preceded the queue leg. Readers of that value: the per-call "waited" figure in the call-path drill, the agent-day view and the escalation cards; also the S2C-6 tile's fallback, which is only used when the journey has no queue leg. The Inbound report averages exclude internal records. Stored rows change only on re-import.
INVARIANTS AT RISK: None.
NET SCORE: 1 − 0 = 1

OPERATOR ACTIONS / DEPLOY:
- After the push, run CDR Tools → Diagnostics → Internal-call wait: before vs after (all dates). Expect SUSPECT 0 and External changed 0, then Manual Export the dates to correct (Operator State #75) | BLOCKS DEPLOY: N
Deploy:
CDR Import: `cd apps-script/cdr-import && clasp push -f`

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- None
DOCUMENTATION UPDATES NEEDED:
- None beyond those made.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
