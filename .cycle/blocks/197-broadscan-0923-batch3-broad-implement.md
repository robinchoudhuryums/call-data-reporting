---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ING-1 — The Direct build took the whole day's date from the first Raw Data row (a D-1 carry-over leg), so P-4 refused the date on every re-run; the date is now the first row ON `expectedDate`.
- S2C-3 — The Direct engine counted other-date legs by time of day (inflating activity, excusing misses as busy); the build now drops legs dated off the build date.
- S2C-1 — Inbound `first_agent` stored a customer's raw caller-ID name from the agent's external-callee talk leg; such legs are now skipped. (The matching-index half was not changed -- see follow-ons.)
- S2C-4 — `icSqlStr_` kept NUL, failing a whole date's inbound/outbound transaction; NUL is now stripped.
- ING-6 — `backfillOutboundCalls` ignored the tunable `IC_BACKFILL_TIME_LIMIT_MS`; it now uses `icBackfillTimeLimitMs_()`.
- ING-2 — On a force re-import the inline CDR/QCD Neon mirrors ran before the remaining sheet rewrites (a hung connect lost those rows silently); they now run in a `finally` after every sheet write.
- ING-7 — `repairCsrTransferForRawDataDate` used the first-row date and rewrote the whole sheet with no lock; now majority date + stray drop + script lock + per-row writes.
Files modified:
- apps-script/cdr-import/directCallMetrics.js
- apps-script/cdr-import/inboundCalls.js
- apps-script/cdr-import/outboundCalls.js
- apps-script/cdr-import/autoImport.js
- tests/unit/direct-call-backfill.test.js
- tests/unit/inbound-calls.test.js
- tests/unit/outbound-calls.test.js
- tests/unit/csr-transfer.test.js
- docs/per-call-capture.md
- docs/fix-history.md

CHANGES:
ING-1 | directCallMetrics.js, direct-call-backfill.test.js | `buildDirectCallFromRaw_` computes `expIso` first and picks the first row whose date parses to it (falls back to the first dated row, so a grid with no row on the expected day still hits the P-4 refusal).
S2C-3 | directCallMetrics.js, direct-call-backfill.test.js | Before the engine, legs whose date parses to anything but the build date are dropped (undated rows kept for the engine's droppedNoStart); `strayLegsDropped` returned and logged. Test: an other-date outgoing call no longer turns a real miss into missed_busy or adds outbound activity.
S2C-1 | inboundCalls.js, inbound-calls.test.js, per-call-capture.md | `firstAgent` loop skips any leg where `icExternalNumber_(CALLEE)` is set.
S2C-4 | inboundCalls.js, inbound-calls.test.js | `icSqlStr_` strips \u0000 before quote-doubling.
ING-6 | outboundCalls.js, outbound-calls.test.js | Budget check uses `icBackfillTimeLimitMs_()` (same project global).
ING-2 | autoImport.js, csr-transfer.test.js | `processIntegratedHistory` queues the CDR and QCD mirror blocks (unchanged bodies, incl. L7 failure rows + emails) in `pendingNeonMirrors`; sections 2-5 run in `try { } finally { run queued mirrors }`, before the Direct section. Test pins sheet-before-mirror order and that a throwing CSR write still mirrors QCD.
ING-7 | autoImport.js, csr-transfer.test.js | New `csrRepairDayRows_` (majority date, other-date legs dropped) and `csrRepairApply_` (writes E..R of each matched row only; F written back unchanged); the entry takes `LockService.getScriptLock().tryLock(30000)` and throws when busy.

TEST RESULTS: passed — `node --test` 1812/1812 (TZ=America/Chicago); INV-16 guard clean; `module-deps --check` clean; `CI=1 npm run lint:gas` clean. ci:ui not run (no client file changed). Every new test was bite-checked red against the pre-change file.
REGRESSION RISKS:
- ING-2: the CDR/QCD Neon mirror now happens AFTER the DQE build; if the DQE build (or its own inline mirror) is killed at the ceiling, the CDR/QCD mirror for that date is skipped where it used to have run. That is a recoverable Neon gap (coverage check #35 / re-import) instead of lost SHEET rows -- the deliberate trade.
- ING-7: the repair now refuses while the import holds the script lock; per-row writes are more `setValues` calls (a few dozen rows per date, fine).
- S2C-1: dial-in labels derived from `first_agent` change for calls whose only person leg was the external-callee talk leg (they now read null instead of a customer name).
INVARIANTS AT RISK: None. INV-16 untouched (no duplicated file edited). INV-06 window logic unchanged. Force-path guard convention: deletes/guards unchanged; only mirror ORDER moved.
NET SCORE: 2 − 1 = 1 (ING-1 + S2C-3 fire whenever a carry-over leg lands in Raw Data -- the P-7 incident class, observed in production; S2C-1 likely but its leg-shape frequency is unmeasured, so not counted. New failure mode: ING-2's later CDR/QCD mirror can be skipped by a DQE-stage kill -- recoverable, recorded above and in fix-history.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (the pipeline runs pushed code). | BLOCKS DEPLOY: N
- Optional: search Pipeline Health for `processIntegratedHistory:Direct` failures reading "Raw Data derives date ... but the caller expected" -- each is a date ING-1 refused; force re-import it (Operator State #56) to write its Direct history. | BLOCKS DEPLOY: N
- Optional: `backfillInboundCalls` with force over the surviving `Call_Legs_*` window re-captures `first_agent` without customer names (older rows keep them). | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- S2C-1 second half: `agentBusy` (the transfer/related-call matcher) keys the agent's answered leg on CALLEE digits, which on an external-callee talk leg is the customer. Re-keying on CALLER needs live evidence of how often a call carries BOTH an agent ring leg and a talk leg, or unique matches become ambiguous and validated enrichment is lost.
- A read-only audit of stored `first_agent` values not on any roster (to size the pre-fix rows) -- needs the roster in cdr-import; not built.
- Remaining broad-scan batches 4-11 (`.cycle/blocks/195-broadscan-0923-plan.md`).

DOCUMENTATION UPDATES NEEDED:
- Done: docs/per-call-capture.md (first_agent rule + remediation), docs/fix-history.md.
- None outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
