---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 1 -- "ingest can't stall or silently lose tabs"):
- HT-1  npm test / npm run ci pin TZ (CI_TZ override, default America/Chicago); force-delete-rows fixtures at noon; tests/README host-TZ note
- PIPE-1 a Call_Legs date whose import returns ERROR no longer blocks newer dates: skipped for the rest of the run, counted in the PENDING_IMPORT_FAILURES ledger, only its first failure emails, PARKED after 3 runs with one `autoImport:parked` failure row (success row once none remain)
- PIPE-2 pending window ends at TODAY (a future-dated tab is never a candidate or the anchor); the retention prune deletes an over-age tab only when PROVEN imported (name in lastSheets, or date in DQE/QCD Historical Data); unproven tabs are kept and named; a failed proof read keeps everything and logs a failure row
- IG-1  bulk CSV importer holds each tab as it is imported (and re-holds skipped existing tabs), insertSheet is inside the per-file try, the loop stops at the bulk time budget, folder errors are the only "Could not access folder"
- PIPE-3 processBatchArchive appends all four history sheets before either Neon mirror opens a connection
- IG-2  DIRECT_UPSERT_RESUME is a T-8-style fingerprinted pointer {index,rowCount,key}; a changed sheet or legacy bare index restarts from 0
- DX-13 neonbackfill.js header no longer claims every *_RESUME pointer anywhere is fingerprinted by nbResumeRead_
- PIPE-5 setAutoCommit(false) moved inside the try/finally in writeQCDRowsToNeon / writeCDRRowsToNeon / mirrorCdrPhonesToNeon (both INV-16 copies)
- PIPE-4 a blank-string numeric cell still writes 0 to Neon but no longer counts as an F5 NON-FINITE coercion

Files modified:
apps-script/cdr-import/autoImport.js, apps-script/cdr-import/DeleteOldSheets.js, apps-script/cdr-import/importBulkCSVsFromDrive.js, apps-script/cdr-import/directCallMetrics.js, apps-script/cdr-import/neonWrite.js, apps-script/cdr-import/propRegistry.js, apps-script/cdr-report/neonWrite.js, apps-script/cdr-report/neonbackfill.js, package.json, tests/README.md, tests/unit/force-delete-rows.test.js, tests/unit/pending-imports.test.js, tests/unit/retention-prune.test.js, tests/unit/csr-transfer.test.js, tests/unit/direct-call-backfill.test.js, tests/unit/neon-write-mapping.test.js, tests/unit/neon-write-chunking.test.js, docs/invariants.md (INV-44), docs/operator-state.md (#43)

CHANGES:
HT-1 | package.json, tests/unit/force-delete-rows.test.js, tests/README.md | `test`/`ci` scripts run under TZ=${CI_TZ:-America/Chicago}; 11 fixture Dates moved to noon (green on UTC/LA/Chicago bare too); README records it
PIPE-1 | autoImport.js (processPendingImports_, processNewImport catch, new pendingImport* helpers), propRegistry.js | failure ledger + per-run skip + park-after-3 + `noFailureEmail` on retries + `autoImport:parked` failure/success rows; PENDING_IMPORT_FAILURES registered as engine state
PIPE-2 | autoImport.js (pendingCallLegsDates_ gains todayIso; pendingImportTodayIso_ seam), DeleteOldSheets.js (retentionHistoryIsos_, provenImported, unimported/historyError in result + prune row) | window anchored on today, future tabs excluded; prune keeps unproven over-age tabs, row names them, failure on a failed proof read
IG-1 | importBulkCSVsFromDrive.js | per-tab retentionHoldTabs_, insertSheet in try, bulkTimeLimitMs_ stop, per-file failure list, "Import stopped" vs folder error
PIPE-3 | autoImport.js (processBatchArchive) | four appends first, then the unchanged CDR and QCD mirror blocks
IG-2 + DX-13 | directCallMetrics.js (dcResumeKey_/dcResumeRead_/dcResumeWrite_), cdr-report/neonbackfill.js header | fingerprinted pointer, restart-on-mismatch logged
PIPE-5 | cdr-import + cdr-report neonWrite.js | setAutoCommit moved inside try in 3 writers; copies byte-identical
PIPE-4 | cdr-import + cdr-report neonWrite.js (neonSqlBlank_) | '' / whitespace not counted by NEON_COERCED_; written value unchanged

TEST RESULTS: passed -- `npm run ci` 1993/1993 (13 new tests), INV-16 guard clean, module-deps up to date; bare `TZ=UTC node --test` 1993/1993; `CI=true npm run lint:gas` clean (75 files). Every new pin was mutation-checked (fails against the old code / a removed guard). ci:ui not run -- no client file touched.
REGRESSION RISKS:
- PIPE-1: a TRANSIENT error that recurs on 3 separate runs parks a date; it then needs Manual Processing (announced by the parked row; prune keeps the tab).
- PIPE-2: the pending window floor moved from (newest tab - 14d) to (today - 14d): normally the same day or one day later, matching the prune's own 14-day cutoff.
- PIPE-2 prune: an over-age tab not in lastSheets AND with no DQE/QCD rows for its date (e.g. a zero-call day after >60 newer names pushed it out of the memo) is now kept until deleted by hand -- named in every prune row. The proof read costs one DQE + one QCD date-column read, only when some over-age tab is missing from the memo.
- IG-1: importCallLegsCsv_ now returns 'failed: ...' instead of throwing when insertSheet fails (only caller updated).
- PIPE-4: the F5 count drops for blank strings only; NaN/undefined/Infinity still counted (pinned).
INVARIANTS AT RISK: INV-16 (both neonWrite.js copies edited -- guard confirms byte-identical); INV-44 (new step `autoImport:parked` -- entry updated; NOT failure-only, so HEALTH_FAILURE_ONLY_STEPS_ unchanged). None violated.
NET SCORE: 1 − 2 = -1 (production fixes: PIPE-4 fired on every daily mirror; PIPE-1/2/3, IG-1/2, PIPE-5 are real mechanisms with no evidence of firing this month. New failure modes, both documented: PIPE-1 parking can require manual processing after a recurring transient error; PIPE-2 can keep an unprovable tab indefinitely.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (all behaviour changes live there) | BLOCKS DEPLOY: Y
- Deploy cdr-report too, to keep the INV-16 neonWrite.js copies identical in production | BLOCKS DEPLOY: N
- After the next ~3 AM prune, read its `retentionPrune` row: any "KEPT N never-imported" tab must be imported (Manual Processing) or deleted by hand (Operator State #43) | BLOCKS DEPLOY: N
- If an `autoImport:parked` failure row appears: fix/re-upload that Call_Legs tab and run Manual Processing for the date, or delete the tab | BLOCKS DEPLOY: N
Deploy:
CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)
CDR Reporting Tools / CDR DQE Pipeline: `cd apps-script/cdr-report && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-report`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A future-dated tab is now ignored until its date arrives, and is then imported as that date; whether the F2 expected-date refusal catches a mis-named tab's data was not verified here.
- Parked dates have no auto-unpark (e.g. retry once a day); kept never-imported tabs are only named in the prune row -- a Health `legs-horizon` hint for them would make both visible on the dashboard.
- PIPE-3 is pinned by source order only; processBatchArchive has no behavioural harness.
- CLAUDE.md's Cycle Workflow Config "Test Command: node --test" and its key-commands block do not mention that `npm test` now pins TZ (DX, broad-scan Batch 12).
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: Test Command / key-commands note that `npm test` pins TZ; optionally a Common Gotchas line on "the prune deletes only proven-imported tabs" (currently only in Operator State #43).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
