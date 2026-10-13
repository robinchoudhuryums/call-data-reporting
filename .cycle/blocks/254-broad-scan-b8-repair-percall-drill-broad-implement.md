---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- PIPE-9  -- a duplicate-merge re-run on an already-merged group re-blanks AI..AK and queues the Neon NULL clear
- TOOL-5  -- the DQE drill-down names the day Raw Data holds instead of "no matching rows" on a date mismatch; unpadded dates match
- PIPE-10 -- the PST shift heals an AF that lags its already-shifted slots
- PIPE-12 -- outbound ring is measured on the attempt that connected
- PIPE-13 -- final_dept and the wait's end point scope to the requester's legs on internal-origin records (the P22 rule)
- PIPE-11 -- an abandoned-id repair with nothing to recover takes no snapshot (the CRT-5 no-op short-circuit)
- PIPE-14 -- previewFirstRingBackfill runs no ALTER TABLE; only apply adds the column
- PIPE-15 -- force inbound/outbound backfills without HMAC_SECRET refuse already-mirrored dates instead of NULLing their hashes
Files modified:
- apps-script/cdr-report/sheetRepairs.js
- apps-script/cdr-report/DQEdrilldown.js
- apps-script/cdr-import/inboundCalls.js
- apps-script/cdr-import/outboundCalls.js
- tests/unit/sheet-repairs-merge.test.js
- tests/unit/dqe-drilldown-parity.test.js
- tests/unit/outbound-calls.test.js
- tests/unit/inbound-calls.test.js
- tests/unit/first-ring-backfill.test.js
- docs/per-call-capture.md
- docs/operator-state.md (#56 note)
- docs/next-steps.md

CHANGES:
PIPE-9  | sheetRepairs.js | mergeDqeDuplicateRows_ collects groups scMergeAlreadyApplied_ recognizes (`extraClears`), re-blanks their row's AI..AK (cols 35..37), and passes them to scClearNeonMergeExtras_ alongside the fresh merges. A run cut short after its sheet write now heals on a re-run instead of leaving a stale Neon split/after-hours pair.
TOOL-5  | DQEdrilldown.js | New drillDayKey_ normalizes M/D/YYYY (padded or not, YY) and ISO to YYYY-MM-DD. getDQEDrilldownRows counts Raw Data's days first and, when the drilled date is absent, returns an error naming the held day(s) plus the Manual Export step. Both in-loop date comparisons use the normalized key.
PIPE-10 | sheetRepairs.js | repairDqeOldPstTimestampShift_ records each row's slot seconds. On an already-CST row whose every AF time is missing from the slots while time+2h is present, it queues an AF-only change (slots:null). New stat afHealedRows appears in the summary; the apply loop skips the slot write for those rows.
PIPE-12 | outboundCalls.js | connLeg = the first talk>0 Answered external leg. Ring runs from THAT leg's START to its CONNECTED, so it no longer runs from attempt 1's start to a later attempt's connect. An unconnected call keeps attempt 1's start -> stop. call_start / call_date still come from attempt 1.
PIPE-13 | inboundCalls.js | answerScope = ownLegs on internal-origin records (falling back to every leg when none match). External records use every leg. The finalDept loop and the wait end-point loop iterate it. firstStart (the wait's start) is unchanged by design.
PIPE-11 | sheetRepairs.js | repairDqeAbandonedIds_ returns {applied:true, noop:true, ...} before hrBackupBeforeApply_ when nothing is recovered or marked lost, still re-applying the plain-text format to the range. No backup tab and no full-range setValues.
PIPE-14 | inboundCalls.js | firstRingBackfill_ runs the ADD COLUMN DDL only when apply. The preview asks information_schema.columns. If the column is missing, it sets out.columnMissing, swaps the population's `first_ring_seconds IS NULL` for TRUE (every row is NULL), and logs that apply/capture adds it.
PIPE-15 | inboundCalls.js, outboundCalls.js | With force and no HMAC_SECRET, both backfills fetch the mirrored-date set and refuse each mirrored date as a FAILED entry. That keeps a deferred-mirror date queued and loud. A never-mirrored date still writes (the PC-10 NULL-hash path). Owner-facing log line names Operator State #17. Design note: a blanket throw was rejected, because it would also stop the deferred mirror writing NEW dates whose Call_Legs source is pruned at 14 days.

TEST RESULTS: passed -- TZ=America/Chicago node --test: 2388 tests, 2387 pass, 0 fail (1 skipped, pre-existing). INV-16 guard in sync; module-deps --check up to date; lint:gas (CI=true) clean, 76 files. ci:ui not run, since no client file changed. 10 new or updated tests. Bite-checked: PIPE-9, TOOL-5 (x2), PIPE-10, PIPE-11, PIPE-12, PIPE-13, PIPE-14 (x2), PIPE-15 (inbound + outbound) all BITE. One expected NO BITE: dropping PIPE-15's `force` gate, because a non-force run already skips mirrored dates via doneDates, so the gate is behaviourally redundant.
REGRESSION RISKS:
- PIPE-12 changes ring_seconds for multi-attempt connected calls going forward; stored rows keep the old value until the date is re-captured. Outbound ring readers (the brief-ring classifier) see shorter, correct rings on those calls.
- PIPE-13 can move final_dept / wait_seconds on internal-origin records with a merged sibling answer. That is intended, and only new captures or re-imports are affected.
- PIPE-15: on a deferred-mirror install with HMAC_SECRET unset, a re-import of an already-mirrored date now stays queued and fails each run until the secret is set (intended; loud). A failed mirrored-date read fails OPEN (writes NULL as before) -- the old behaviour, not a new loss.
- PIPE-14: the information_schema check has no schema filter. A same-named table in another schema could report the column present; the preview's read would then fail loudly, never silently.
INVARIANTS AT RISK: None.
- INV-16 untouched; neither duplicated file was edited.
- INV-01 n/a (cdr-import/cdr-report editor tools).
- The 1b snapshot rule holds: PIPE-11 returns before ANY write, and the backup-order source pin stays green.
- CRT-7 re-verify order unchanged.
NET SCORE: 3 − 0 = 3
- Would fire this month: TOOL-5, PIPE-12, PIPE-13.
- Defensive / operator-run-only: PIPE-9, PIPE-10, PIPE-11, PIPE-14, PIPE-15.

OPERATOR ACTIONS / DEPLOY:
- None new. Optional: force re-import recent dates inside the Call_Legs window if corrected outbound rings / internal-origin final_dept are wanted on stored rows | BLOCKS DEPLOY: N
Deploy:
CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
CDR Import: `cd apps-script/cdr-import && clasp push -f`

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- PIPE-13 left firstStart (the wait's START) on legs[0] for internal records, per the P-rule "identity, not the clock". If a sibling's leg starts well before the requester's queue leg, wait_seconds still includes that gap. Worth an owner ruling on whether the wait should start at the origin (queue) leg.
- PIPE-15's mirrored-date read fails open. A fail-closed variant (refuse every date when the read errors and the secret is missing) is possible if the owner prefers.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made: per-call-capture.md (PIPE-12/13/14/15), operator-state.md #56 (PIPE-9/10), next-steps.md Batch 8 row.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
