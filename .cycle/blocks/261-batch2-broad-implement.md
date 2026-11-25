---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F1 (filed PCC-1) — the per-call Direct list (`direct_calls`) is no longer lost after a failed Neon write: every "is this date whole?" check now asks Neon, and a date it lacks is rebuilt from its Call_Legs tab before the tab can go
- F36 (filed PCC-2) — the bulk path queues a date's replacement rows BEFORE force-deleting it, and Pending Archive appends the fresh rows before deleting the stale ones
- F37 (filed PCC-3) — the editor-run CSR Transfer repair sets the CR-5 marker and re-verifies its rows before writing, so the nightly sort cannot make it write onto other rows
New capabilities (G/ST): None
Files modified:
- apps-script/cdr-import/directCallMetrics.js (dcNeonDirectOwed_)
- apps-script/cdr-import/autoImport.js (pendingImportDirectCatchUp_, the daily Direct failure note, DATE_WHOLE_NEON_TABLES_ / dateWholeLedger_ / dateWholeOwed_, processNewImport's bulk queue order, queueToPendingArchive's P-7 order, repairCsrTransferForRawDataDate / csrRepairApply_)
- apps-script/cdr-import/DeleteOldSheets.js (retentionDerivedOwed_)
- tests/unit/pending-imports.test.js, direct-calls-capture.test.js, retention-prune.test.js, rebuild-report-truth.test.js, csr-transfer.test.js
- docs/fix-history.md (PCC-1..3), docs/operator-state.md (#26, #43)

Fix codes: scan F1 / F36 / F37 are filed as PCC-1 / PCC-2 / PCC-3 (bare `F#` collides with the Neon family; the VS-1 / TT-1 precedent from Batch 1).

CHANGES:
F1 / PCC-1 | directCallMetrics.js | New `dcNeonDirectOwed_(iso, opts)`: one bounded statement counting the date's `direct_call_history` rows, the calls they hold (the eight ib_* / ob_* count columns) and its `direct_calls` rows. Owed when the counts are absent, or hold calls with no per-call row; a quiet day (no calls counted) is never owed; NEON_HOST unset is never owed; `opts.neonDown` skips the connect; a failed read is owed ("not confirmed"). Connection closed on every path.
F1 / PCC-1 | autoImport.js pendingImportDirectCatchUp_ | When the SHEET already holds the date it now asks dcNeonDirectOwed_ and rebuilds from the tab when owed (Neon down: returns false, no rebuild). After any rebuild, a Neon write that failed (configured) returns FALSE -- it used to return true, which let the prune delete the tab. The Health note names why it rebuilt.
F1 / PCC-1 | DeleteOldSheets.js retentionDerivedOwed_ | Neon is probed once per run BEFORE the Direct check (it reads Neon now) and the result is passed down as `neonDown`; the owed text reads "Direct not whole (Direct Call History or its Neon copy)".
F1 / PCC-1 | autoImport.js Make a date whole | `direct_calls` joins DATE_WHOLE_NEON_TABLES_; the ledger sums the counts' calls (`directActivity`, null when unread); `dateWholeOwed_` owes `direct_calls` only when calls were counted. The catch-up fix above is what Make a date whole runs, so it now rebuilds the list too.
F1 / PCC-1 | autoImport.js daily Direct block | The `:Direct:neon` failure note no longer tells the operator a backfill fixes it: it says the backfill restores counts only and the list comes back from the tab (Make a date whole, or the prune before the tab goes).
F36 / PCC-2 | autoImport.js processNewImport | On the bulk path `queueToPendingArchive` runs before the force-delete block, with the skips the post-delete flags would have had (all false under force except a CSR the RB-6 header check kept); the bulk branch reuses the result (`const queued = bulkQueued`, keeping the RB-4 source pin).
F36 / PCC-2 | autoImport.js queueToPendingArchive | Append fresh rows first, then delete the stale ones bottom-up (stale rows sit above the new ones).
F37 / PCC-3 | autoImport.js repairCsrTransferForRawDataDate / csrRepairApply_ | `bulkMarkerSet_` / `bulkMarkerClear_` (finally) around the apply; the apply PLANS every write, then re-reads the row count and the planned rows' date + agent cells and throws "changed while the repair ran ... NOTHING was written; re-run" on any difference, then writes.
Tests | pending-imports.test.js | PCC-1 catch-up: whole -> no rebuild; owed -> rebuilt with the reason in the note; a rebuild whose Neon write fails -> false; Neon down -> false and no rebuild, the flag passed on; the sheet-missing path's Neon failure -> false. Ledger tests updated for the seventh table + directActivity; dateWholeOwed_ cases for owed / quiet day / unread sum / perCallChecked. Bite-checked (the early return restored -> red).
Tests | direct-calls-capture.test.js | dcNeonDirectOwed_ against a fake connection: unconfigured, unreachable, neonDown (no connect), no history, counts without a list, whole, quiet day, read failure (connection still closed).
Tests | retention-prune.test.js | owed text updated; the Neon-down run passes neonDown to the Direct catch-up.
Tests | rebuild-report-truth.test.js | PCC-2 behavioural (REAL processBulkQueue: a queue that throws keeps that date's original DQE row, no success line) + an order pin. Bite-checked against the pre-PCC-2 file: both red.
Tests | csr-transfer.test.js | PCC-3: marker set + cleared on abort; a row swapped under the repair aborts with nothing written. Bite-checked (re-verify disabled -> red).

TEST RESULTS: passed -- `node --test` (TZ=America/Chicago) 3,207 tests, 3,206 pass, 0 fail, 1 skipped; `check-duplicated-files.sh` clean; `npm run lint:gas` clean (82 files); `module-deps.mjs --check` up to date. `npm run ci:ui` NOT run: no dashboard file changed.
Regression scenarios: S5, S28, S33, S34 (CDR Import) -- NOT APPLICABLE here (they need the live import); walk after the cdr-import push.

REGRESSION RISKS:
- PCC-1: the pending catch-up and Make a date whole now open one Neon connection per date to check Direct (the prune shares its one probe). A date whose check keeps failing for a reason other than reachability (permissions, a dropped table) is kept by the prune as "not confirmed" every night; the prune row names it, and a long run of them grows the import workbook (#62).
- PCC-1: the sheet-missing catch-up now returns false on a Neon failure -- the pending ledger retries it and parks it after PENDING_IMPORT_MAX_ATTEMPTS_, where it used to clear the date at once (and lose the list).
- PCC-2: if the stale-row delete throws AFTER the append, the date's queued rows are doubled until the next run of that date (P-7 replaces both sets then); before, the same failure lost them.
- PCC-3: none beyond the abort itself, which writes nothing and says to re-run.

INVARIANTS AT RISK:
- INV-56 — the new statement uses setQueryTimeout(30) on a probed connection; no URL properties. Not violated.
- INV-71 — the force delete is unchanged; only its order relative to the bulk queue moved. Not violated.
- INV-16 — no duplicated file touched (guard clean).
None violated.

REFLECT:
- PCC-1: (a) fired this month? NO evidence -- it needs a morning whose Direct write could not reach Neon. (b) new failure mode? YES (Low) -- a date whose Neon check keeps failing is kept by the prune every night.
- PCC-2: (a) NO. (b) YES (Low) -- a delete failing after the append doubles that date's queued rows until its next run.
- PCC-3: (a) NO. (b) NO.
Tally: 0 production fixes − 2 new failure modes = −2.

NET SCORE: 0 − 2 = −2

OPERATOR ACTIONS / DEPLOY:
- None required beyond the push. Optional: for a recent date whose agent-panel Direct tab is empty while the counts are not, run CDR Tools -> Make a date whole while its Call_Legs tab still exists -- it now rebuilds the list. | BLOCKS DEPLOY: N
Deploy:
- CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)
(Not complete in production until that push is confirmed.)

FOLLOW-ON ITEMS:
- FO-261-3 | cdr-import autoImport.js processIntegratedHistory block 6: a daily Direct write that misses Neon is still not put in the pending ledger -- the retention prune (day 15) is now the backstop that catches it, so if the prune trigger is not installed (#43) nothing does | → next audit

DOCUMENTATION UPDATES NEEDED:
- None beyond those made (fix-history PCC-1..3, Operator State #26 and #43). /sync-docs may want #90 to name PCC-1.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
