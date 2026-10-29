---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: HOH-0 (owner 2026-10-28, point 1) -- a read-only diagnostic sizing how often "hung up on hold" is a transfer side effect rather than a hang-up; XB-0 (point 3) -- a read-only diagnostic counting transfers that came back to the department that first answered (Sales -> CSR -> Sales). Plus the QF-2 follow-up the owner asked for: the quiet button style is global.
New capabilities (G/ST): None (both diagnostics are research tools sizing owner decisions HOH-1 / XB-1)
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/transferFilter.js, apps-script/department-dashboard/styles.html, tests/unit/inbound-calls.test.js, tests/unit/transfer-filter.test.js, tools/ui-harness/drive-admin.js, docs/operator-state.md (#85, #86), CLAUDE.md (#85, #86 index lines), docs/per-call-capture.md, docs/fix-history.md, docs/client-ui-conventions.md, tests/README.md, .cycle/STATE.md

CHANGES:
HOH-0 | inboundCalls.js | PURE `icHoldHangupShape_` (the call's LAST flagged caller leg: final / answeredAfter / unansweredAfter, with a 2 s slack, recording legs ignored; whether that leg held / was answered), `icHoldHangupFold_`, `icHoldHangupsForGrid_` (the capture's own outside-call records + their leg groups), `icHoldHangupLine_`; editor entry `diagnoseHoldHangups(date|'all')` + `diagnoseHoldHangupsAllDates()`: per date and TOTAL, the dispositions per class and call-id samples. Writes nothing.
XB-0 | transferFilter.js | PURE `tfBounceOfJourney_` (journey -> department stints: queues via the Dept Config rows, answerers via the roster with the capture's canonicalizer; missed rings, attempts and consults are not moves, a hand-over is; two-roster agents / unmapped or shared queues skipped and counted; a bounce = an answered stint A, later A again with another department between -- sentBack when an agent there answered, returnedUnanswered otherwise), `tfBounceLookups_`, `tfBounceFold_`, `tfTopCounts_`, `tfBouncesForGrid_`, `tfBounceLine_`; editor entry `diagnoseTransferBounces(date|'all')` + `diagnoseTransferBouncesAllDates()`: per date and TOTAL, department trios, first senders, samples, queues not placed. Writes nothing.
QF-2 follow-up | styles.html, drive-admin.js | `.btn-ghost` is a GLOBAL rule next to `.btn-secondary` (the coaching worklist's Dismissed and the tour's Skip / Back were still the solid default); the driver pins that a bare btn-ghost is quiet.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 2725 pass / 0 fail (+11); lint:gas clean; INV-16 guard clean; module-deps clean; claude-md-split 11/11; ci:ui all stages passed (incl. "a btn-ghost anywhere on the page is quiet"). Bites 8/8 after one test was sharpened (the case-insensitive queue test looked up an already-lowercase name, so the mutation could not bite; it now uses 'A_Q_Csr').
REGRESSION RISKS: None for the figures -- both diagnostics are editor-run and read-only, and the capture builder is called, not changed. The global `.btn-ghost` changes the look of the coaching Dismissed button and the tour's Skip / Back (to the quiet style the class always intended).
INVARIANTS AT RISK: None -- no write path, no public endpoint, no capture change; logs carry call ids, employee and queue names only (no phone number, no CNAM).
NET SCORE: 1 − 0 = 1 (the btn-ghost follow-up fires today; the diagnostics are research tools)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (the two diagnostics) and the dashboard (the global quiet button) | BLOCKS DEPLOY: N
- Run `diagnoseHoldHangupsAllDates()` and `diagnoseTransferBouncesAllDates()` from the cdr-import Run picker and send both logs | BLOCKS DEPLOY: N
- If XB-0 lists "queues not placed", give those queues a Dept Config row (or tell me which department owns each) and re-run | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- HOH-1 (after the HOH-0 log): count a call as "hung up on hold" only when its flagged leg ends the call, and mark it on that leg's row -- moves the Inbound report's on-hold figures and the transfer-abandon counts; owner to approve.
- XB-1 (after the XB-0 log): a stored record per bounced call (from / to / first sender) and a report; journeys keep only 90 days, so long-term analysis needs the stored field. Owner to confirm: a consult that ends with the first agent is not a bounce; a two-roster agent is skipped; is a sub-queue (PAP under Sales) its own department here?
- The #5 + #6 callbacks design mock (next in the agreed order).

DOCUMENTATION UPDATES NEEDED:
- None (Operator State #85 / #86, their CLAUDE.md index lines, per-call-capture.md, fix-history HOH-0 / XB-0, tests/README updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
