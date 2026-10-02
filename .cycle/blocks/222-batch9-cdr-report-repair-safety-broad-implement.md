---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 9 -- "cdr-report repair and report safety"; cdr-report + cdr-import, one dashboard constant):
- CR-1 every DQE bulk repair apply now snapshots FIRST and re-verifies the rows AFTER the snapshot, immediately before its first write -- four of five re-checked before the ~1.2M-cell copy, so a build landing during the copy went unseen; the order is pinned for all five
- CR-2 the CRT-7 fingerprint adds a checksum (FNV-1a over display values) of the columns each apply REWRITES, so a same-position force rebuild (same rows, same date/agent, new values) aborts the write too; the slot repair, which changes its own columns' format mid-run, checksums each group after its own read
- CR-3 a slot-repair abort restores that group's ORIGINAL number formats (it was left in the numeric lens) and the message names any group already written instead of claiming "Nothing was written"
- CR-4 the repair backup prunes to KEEP-1 tabs BEFORE copying, so the backup workbook never briefly holds KEEP+1 DQE copies on its way to the 10M-cell cap
- CR-5 a cross-project "bulk in progress" marker: cdr-import's processBulkQueue sets spreadsheet DeveloperMetadata `cdrImport.bulkInProgress` on the CDR Report workbook while it holds its run (cleared in the finally, a pause included); the nightly historical sort skips every sheet (success rows) while a marker <= 45 min old is present, and ignores an older one as a killed run's leftover
- CR-9 INV-52's premise rewritten (CDR Historical is read LIVE by the Custom Report Builder; Q Path has no reader); CDR Historical gets the M2 force-path loss guard on both paths (processIntegratedHistory:CDR daily, bulkBackfill:CDR bulk -- the latter registered failure-only on the Health page); Q Path deliberately stays unguarded
- CR-7 detect-only previewDqeQueueExtColumn() (cdr-report, editor-run) classifies DQE col D: clean text / empty / lossless single numeric ext / likely-merged multi-ext number (> 5 digits) / other, with the dates to rebuild -- no automatic repair, a merged number cannot be split back with certainty
- CR-10 the Custom Report Builder's comparison window is the same number of CALENDAR days (noon-anchored), not the current window's millisecond length -- a window holding the November fall-back compared 7 days against 8

Files modified:
apps-script/cdr-report/sheetRepairs.js, apps-script/cdr-report/dashboardCDR.js, apps-script/cdr-import/autoImport.js, apps-script/department-dashboard/SystemHealth.gs (HEALTH_FAILURE_ONLY_STEPS_ += bulkBackfill:CDR), tests/harness/fakeSheet.js (setNumberFormats modelled, recorded + shape-checked), tests/unit/sheet-repairs-backup.test.js, tests/unit/sheet-repairs-merge.test.js, tests/unit/historical-sort.test.js, tests/unit/dashboard-cdr-core.test.js, tests/unit/csr-transfer.test.js, tests/unit/system-health.test.js, CLAUDE.md (repairs bullet; force-guard sentence), docs/invariants.md (INV-44 step names, INV-52 readers), docs/operator-state.md (#59, #61), docs/known-issues.md (coerced col D), docs/module-dependencies.md (regenerated)

CHANGES:
CR-1 | sheetRepairs.js (4 applies: hrBackupBeforeApply_ then hrReverifyRows_; header comment) |
CR-2 | sheetRepairs.js (hrRowFingerprint_(sheet, cols), hrColsChecksum_, hrReverifyRows_ compares sum; abandoned-ids [[30,2]], pst-shift [[11,19],[32,1]], merge [[4,31]]; slot repair per-group grpSnap) | date-normalize rewrites col B, already in the keys
CR-3 | sheetRepairs.js (repairDqeSlotTimestamps_: priorFormats captured on apply, try/catch around both re-checks, setNumberFormats restore, `written` list in the message) |
CR-4 | sheetRepairs.js (hrBackupBeforeApply_ prune-then-copy) |
CR-5 | autoImport.js (BULK_IN_PROGRESS_KEY_, bulkMarkerSet_/bulkMarkerClear_, set after the target open, cleared in the finally), sheetRepairs.js (HISTORICAL_SORT_BULK_KEY_, HISTORICAL_SORT_BULK_MAX_AGE_MIN_=45, hsBulkInProgress_, per-sheet skip) | keys pinned equal across projects
CR-9 | autoImport.js (forceDeleted.cdr, daily + bulk guardForceRebuildLoss_), SystemHealth.gs, invariants.md, CLAUDE.md |
CR-7 | sheetRepairs.js (QD_MAX_EXT_DIGITS_, previewDqeQueueExtColumn), known-issues.md |
CR-10 | dashboardCDR.js (calendar-day span) |

TEST RESULTS: passed -- `npm run ci` 2100/2100 (10 new tests), INV-16 guard clean, module-deps regenerated + up to date; bare `TZ=UTC node --test` 2100/2100 (CR-10's DST test is vacuous under UTC by construction -- it bites under the America/Chicago the suite and CI run in); `CI=true npm run lint:gas` clean (75 files). Mutation-checked: reverting sheetRepairs.js fails CR-1/CR-2/CR-3/CR-4/CR-7 and the three CR-5 tests; reverting autoImport.js fails the CR-9 wiring pin, the I-6 anchor and the CR-5 writer pin; reverting dashboardCDR.js fails CR-10. Test doubles updated as part of the fixes: csr-transfer's I-6 pin anchored on the exact `forceDeleted` literal CR-9 extended; system-health's failure-only list gained bulkBackfill:CDR; the fake sheet now models setNumberFormats (the CR-3 restore path calls it; recorded like setNumberFormat, shape-checked like the real API -- a fidelity addition, not a loosening). Two failures mid-run were this session's own (a CR-4 test written against a helper this suite does not have; the module map stale by one line count). ci:ui not run -- no client file touched. Regression Scenarios S5/S28/S33/S34 not walked live (no deployment here).
REGRESSION RISKS:
- CR-1: none functional -- the same two calls in the other order; an apply can now abort AFTER its snapshot (the snapshot is then a harmless extra tab).
- CR-2: every DQE apply reads the columns it rewrites twice more (fingerprint + re-check); the merge's D..AH is ~1M cells, adding seconds. An apply now also aborts when a value in those columns changed under it -- intended.
- CR-3: none -- the abort path only.
- CR-4: if the copy itself FAILS after the prune, the oldest snapshot is already gone (the window drops to KEEP-1 until the next good copy). Accepted for not hitting the cap.
- CR-5: a nightly sort that lands during a bulk run is deferred to the next night; a bulk invocation killed by the ceiling leaves a marker that blocks at most one night's sort (ignored past 45 min). A DeveloperMetadata failure is best-effort on both sides (logged, never thrown) -- it degrades to the pre-CR-5 race, not to a blocked import.
- CR-9: a force rebuild of a date with genuinely zero CDR agents (an empty day after a non-empty one) now logs a failure row -- the same trade every guarded sheet already makes (P26 keeps it to dates whose CDR rows were really deleted).
- CR-10: a comparison window that previously ran one day long now ends a day earlier -- a correction.
INVARIANTS AT RISK: INV-16 (neither duplicated file touched; guard clean); INV-44 (new step name bulkBackfill:CDR -- entry and the failure-only list updated together, pinned); INV-52 (rewritten); INV-01 (no dashboard write path added). None violated.
NET SCORE: 0 − 1 = -1 (production fixes this month: none of the eight fired in October on the evidence -- the repairs and bulk chain are rare operator runs, the DST edge arrives Nov 1, the cap is ~6k rows away. New failure mode, documented above: CR-4's prune-before-copy can cost the oldest snapshot when a copy fails.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-report (CR-1/2/3/4/5 reader/7/10) | BLOCKS DEPLOY: Y
- Deploy cdr-import (CR-5 writer, CR-9 guards) | BLOCKS DEPLOY: Y
- Deploy the dashboard (the failure-only step name, so a bulkBackfill:CDR row ages out like its siblings) | BLOCKS DEPLOY: N
- Optional: run previewDqeQueueExtColumn() once in the cdr-report editor; rebuild any dates it lists (Operator State #56) | BLOCKS DEPLOY: N
Deploy:
CDR Reporting Tools / CDR DQE Pipeline: `scripts/deploy.sh apps-script/cdr-report`
CDR Import: `scripts/deploy.sh apps-script/cdr-import`
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- CR-5 covers the BULK chain only; the daily force path (Manual Export / onChange) runs the same delete-by-position and could in principle meet the 3 AM sort -- the marker helpers are reusable if that ever matters.
- CR-8 (the sheetRepairs.js docblock still prescribing `new Date(Y,M-1,D)`) was not in this batch's list.
- The scan suggested restoring '@' on a CR-3 abort; this restores each cell's ORIGINAL format instead (the F-52 discipline -- '@' would change how still-coerced cells display to every reader).
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit. /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
