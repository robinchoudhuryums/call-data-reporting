---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ING-3 follow-on: the DAILY inline CDR/QCD Neon mirror's unreachable SKIP now logs the same failure-only Pipeline Health row its throw already did.
- CRT-1: Inbound/Outbound export tabs no longer re-arm apostrophe-neutralized formulas; the per-date replace deletes rows in blocks instead of rewriting the kept rows.
- CRT-7: the five DQE bulk repairs re-check row identity right before writing and abort with nothing written if the daily build changed the sheet.
- CRT-3: the duplicate merge no longer re-sums identical counts-only duplicates (a double append); it keeps one.
- CRT-5: the repair-backup keep window is 6 (covers the five-apply DQE chain), and a slot repair that finds nothing coerced takes no snapshot.
- CRT-4: the DQE upsert keeps Neon's stored slot/AD/AE/AF value instead of overwriting it with NULL/#REBUILD when the sheet cell is unrecoverable.
- CRT-8: the DQE Duplicate Rows report neutralizes formula-leading agent names.
- S2B-7: the Orphan Fix column rename and the Dept Config team-avg-excludes cell neutralize formula-leading names (and the rename no longer re-arms untouched cells).
Files modified:
- apps-script/cdr-import/autoImport.js
- apps-script/cdr-report/inboundCallsExport.js
- apps-script/cdr-report/outboundCallsExport.js
- apps-script/cdr-report/sheetRepairs.js
- apps-script/cdr-report/neonbackfill.js
- apps-script/department-dashboard/OrphanFix.gs
- apps-script/department-dashboard/DeptConfig.gs
- tests/unit/csr-transfer.test.js
- tests/unit/inbound-export.test.js
- tests/unit/sheet-repairs-merge.test.js
- tests/unit/sheet-repairs-backup.test.js
- tests/unit/neon-backfill-resume.test.js
- tests/unit/cdr-egress-metering.test.js
- tests/unit/orphan-rename-race.test.js
- tests/unit/dept-config.test.js
- CLAUDE.md
- docs/fix-history.md
- docs/operator-state.md
- docs/next-steps.md
- docs/module-dependencies.md

CHANGES:
ING-3 follow-on | cdr-import/autoImport.js, csr-transfer.test.js | New `dailyMirrorSkipRow_(targetSS, step, dateObj, skipped)` is called from both daily skip branches (`processIntegratedHistory:CDR:neon` / `:QCD:neon`, failure-only). It stays silent without NEON_HOST.
CRT-1 | inboundCallsExport.js, outboundCallsExport.js, inbound-export.test.js | `ic_/oc_removeRowsInRange_` read only col A display values, pad with `insertRowsAfter(max, n)` first, then `deleteRows` bottom-up blocks. There is no getValues/setValues round trip.
CRT-7 | sheetRepairs.js, sheet-repairs-merge.test.js | New `hrRowFingerprint_` (lastRow + cols B..C) and `hrReverifyRows_` (throws "… ABORTED before writing …"). Both are wired into the slot, abandoned-ids, pst-shift, duplicate-merge and date-normalize applies.
CRT-3 | sheetRepairs.js, sheet-repairs-merge.test.js | In `mergeDqeDuplicateRows_`, a group whose duplicates equal the first row across D..AH is delete-only. This check runs before the R8-B6 detector.
CRT-5 | sheetRepairs.js, sheet-repairs-backup.test.js, sheet-repairs-merge.test.js | `HR_BACKUP_KEEP_` 3 → 6. The slot repair pre-scans with plain `getValues` (non-string, non-empty means coerced); when nothing is coerced it only sets the `'@'` format lock and returns `{noop:true}`. The prune test now derives its labels from the keep value.
CRT-4 | neonbackfill.js, neon-backfill-resume.test.js, cdr-egress-metering.test.js | `nbSanitizeDqeCells_` now also returns `lost` (existing fields unchanged). New `nbKeepStoredForLostCells_` does one bounded SELECT per affected batch, metered as `backfill:dqe-keep-stored`, and substitutes real stored values. It is best-effort. `DQE_UPSERT_LAST` gets `kept-from-neon=N`. `neonbackfill.js` is removed from `UNMETERED_ALLOWED`.
CRT-8 | neonbackfill.js | `findDqeDuplicateRows` passes the agent cell through `crSheetSafeCell_` (typeof-guarded).
S2B-7 | OrphanFix.gs, DeptConfig.gs | `renameHistoricalAgent_` passes every written cell through `sheetSafeCell_`. `sheetUpsertDeptConfigRow_` passes the team-avg-excludes cell through it.

TEST RESULTS: passed.
- `node --test`: 1840/1840 (TZ=America/Chicago).
- INV-16 guard: clean. `module-deps --check`: clean (regenerated). `CI=1 npm run lint:gas`: clean.
- ci:ui not run: no client file changed.
- Every new test was bite-checked red against the pre-change files.
REGRESSION RISKS:
- ING-3 follow-on: during a Neon outage every daily import now adds a failure row, so the pipeline-failure watchdog (#32) emails about it. Before, only a throw did. That is intended, but it adds email volume during a long outage.
- CRT-1: the export now issues `deleteRows` calls instead of one `setValues`. It is still bounded by the refreshed date blocks.
- CRT-7: a repair that overlaps a daily build now aborts instead of writing, so the operator re-runs it outside the build window.
- CRT-3: two genuinely different spellings of one agent carrying identical figures across all 31 columns would now be de-duplicated rather than summed. That is judged far less likely than a double append.
- CRT-4: a failed pre-read falls back to the old overwrite behaviour, and logs it.
- S2B-7: `sheetSafeCell_` also prefixes a name that starts with `-` or `+`. The stored value is unchanged; it gains only the display apostrophe.
INVARIANTS AT RISK: None.
- INV-16: no duplicated file or function was edited. The guard is clean, and the `sanitize*ForNeon_` copies are untouched.
- INV-04: the apostrophe is formatting, so exact name matching is unaffected.
- INV-01: no new public write.
- INV-44: no new step names; the skip reuses the existing failure-only names.
NET SCORE: 1 − 0 = 1.
- Production fix: the daily-mirror skip row. Neon-unreachable imports have happened (the quota and suspend incidents).
- The rest need a crafted name, an overlapping repair, a corrupted-then-upserted cell, or a counts-only double append.
- No new failure modes; the CRT-7 abort is a deliberate, documented refusal.

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (daily skip row), cdr-report (CRT-1/3/4/5/7/8) and the dashboard (S2B-7). | BLOCKS DEPLOY: N
Deploy:
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
- Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- DeptConfig's `qcdQueues` cell is written raw like the excludes. Those names are validated against QCD col D, which is itself feed-sourced; that is the same class and was not in scope.
- The deferred mirror (`NeonMirror.js`) and the dup-guard re-mirror use DO-UPDATE paths that were not checked for the CRT-4 overwrite shape.
- Remaining broad-scan batches 6–11 (`.cycle/blocks/195-broadscan-0923-plan.md`).

DOCUMENTATION UPDATES NEEDED:
- Done:
  - CLAUDE.md "Bulk sheet repairs" bullet (keep 6 + the CRT-7 re-verify rule)
  - docs/operator-state.md #59
  - docs/fix-history.md (Batch 5 section)
  - docs/next-steps.md (keep count)
- None outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
