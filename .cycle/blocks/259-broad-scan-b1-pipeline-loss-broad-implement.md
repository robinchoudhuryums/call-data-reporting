---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F7: the pending-import catch-up's "ALREADY IN HISTORY" path now also rebuilds Direct Call History (when missing) and re-mirrors CDR/QCD/DQE to Neon (deferred mode: queues the date), keeping the date pending when a step cannot finish
- F8: a per-call capture written WITHOUT phone hashes (no HMAC_SECRET) is now a FAILURE on every backfill-driven path (inboundBackfill / outboundBackfill rows, the deferred drain's neonMirror:Inbound / :Outbound step), not a success
- F9: the Call_Legs retention prune keeps an over-age, imported tab whose per-call capture is still owed (Neon Mirror Queue or the PENDING_IMPORT_FAILURES ledger) and names it
- F10: corrected the "every upsert COALESCEs" claim -- only the non-authoritative backfillDQEHistoryUpsert COALESCEs; every authoritative per-date writer deletes the date first
New capabilities (G/ST): None
Files modified:
- apps-script/cdr-import/autoImport.js
- apps-script/cdr-import/NeonMirror.js
- apps-script/cdr-import/inboundCalls.js
- apps-script/cdr-import/outboundCalls.js
- apps-script/cdr-import/DeleteOldSheets.js
- apps-script/cdr-import/neonWrite.js + apps-script/cdr-report/neonWrite.js (comment only, INV-16 pair)
- apps-script/cdr-import/buildDQEHistoricalData.js + apps-script/cdr-report/buildDQEHistoricalData.js (comment only, INV-16 pair)
- CLAUDE.md, docs/invariants.md (INV-10, INV-44), docs/operator-state.md (#43, #56), docs/per-call-capture.md
- tests/unit/pending-imports.test.js, tests/unit/outbound-calls.test.js, tests/unit/neon-mirror-tail.test.js, tests/unit/retention-prune.test.js

CHANGES:
F7 | autoImport.js, NeonMirror.js | processPendingImports_ runs pendingImportPerCallCatchUp_ AND the new pendingImportDerivedCatchUp_ (both always run) for an ALREADY IN HISTORY date. pendingImportDirectCatchUp_ rebuilds Direct from the Call_Legs tab's display grid via buildDirectCallFromRaw_ (expectedDate-pinned; Raw Data untouched) only when Direct Call History lacks the date, logging processIntegratedHistory:Direct (+ :Direct:neon on a mirror skip). pendingImportMirrorCatchUp_: deferred -> enqueueNeonMirror_ (which now returns true/false); inline + NEON_HOST set -> mirrorCdrForDate_ / mirrorQcdForDate_ / mirrorDqeForDate_ (authoritative), each failure a row under the inline FAILURE-ONLY names; NEON_HOST unset -> skipped. Any unfinished step keeps the date in the PIPE-7 ledger (err text names F7).
F8 | inboundCalls.js, outboundCalls.js, NeonMirror.js | both backfills tally res.hashless dates, put "WRITTEN WITHOUT phone hashes: <dates>" in the summary, fail the summary row, return `hashless`. mirrorInbound/OutboundForDate_ return {hashless, rows, note}; neonMirrorDate_ logs that step as a failure row but keeps allOk (the date completes -- a retry cannot add hashes).
F9 | DeleteOldSheets.js | new retentionOwedIsos_ (PENDING_IMPORT_FAILURES keys + Neon Mirror Queue col B in the target workbook, Date cells formatted in script TZ like the drain). Read once, lazily, only when a proven-imported over-age tab is about to be deleted; owed -> kept + listed (`owed`), named in the retentionPrune row; a failed read keeps the tab and fails the row.
F10 | neonWrite.js x2, buildDQEHistoricalData.js x2, NeonMirror.js, CLAUDE.md, docs/invariants.md | comments/docs now say the shared writer's COALESCE is moot under `authoritative` (every current caller) and only cdr-report's row-batched upsert keeps a stored value.

TEST RESULTS: passed -- TZ=America/Chicago node --test: 2434 tests, 2433 pass, 0 fail, 1 skipped (CH-4 snapshot writer, by design). +11 tests. 8/8 manual bites caught (F8 x3, F7 x3, F9 x2). INV-16 guard clean; module-deps --check clean; npm run lint:gas clean (75 files). ci:ui not run (no client change).
REGRESSION RISKS:
- F7 inline mode re-mirrors CDR/QCD/DQE for EVERY "already in history" date it meets (authoritative, identical rows) -- extra Neon writes/egress for dates imported by a path that does not record lastSheets; rare, and remembered after one pass.
- F7 builds Direct from the Call_Legs tab's display grid instead of Raw Data's display grid (Raw Data stages numeric strings as Numbers). Expected equivalent for Direct's fields; not proven against live data.
- F8 turns previously-green rows red on any install running without HMAC_SECRET in cdr-import (intended).
- F9 keeps a PARKED ledger date's tab until the operator acts (more cells held; named in the row).
INVARIANTS AT RISK: None -- INV-16 pair edited identically (guard green); INV-44 step names reused, doc updated for the new failure meaning; INV-06/07/08 untouched (no build rule change).
NET SCORE: 0 production fixes (none confirmed to have fired this month: each needs a killed run, a missing HMAC_SECRET or a >14-day owed capture) − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- None required. Optional: confirm HMAC_SECRET is set in cdr-import (Operator State #17) -- F8 now turns its absence red on the backfill/deferred paths | BLOCKS DEPLOY: N
Deploy:
- CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` -- comment-only change in the INV-16 pair; push to keep the deployed copies byte-identical, no behaviour change

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- F7 does not re-run the CSR-guard or Q Path steps for a killed date (sheets already written; no Neon twin) -- none needed today.
- The PIPE-7 per-call catch-up itself does not surface a hashless backfill result in its own console line (the backfill's row now does).
- npm ci was run locally to get eslint (node_modules is gitignored; no tracked change).
DOCUMENTATION UPDATES NEEDED:
- None beyond those made here (CLAUDE.md col-AI + AJ/AK bullets, INV-10, INV-44, Operator State #43 / #56, per-call-capture.md).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
