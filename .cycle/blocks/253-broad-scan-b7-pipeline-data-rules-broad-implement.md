---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ENG-7 follow-on (Batch 6): each Alert Log row that could not be written carries a `logFailed` field that survives serialization. The Alerts modal counts these rows after a manual send and warns that the sends stand and must not be repeated.
- ENG-14 follow-on (Batch 6): `diagnoseAbandoned` says it cannot trace when the DQE sheet is missing or empty, naming the Neon read source when that is set. It no longer just returns silently.
- PIPE-1: the bulk archive's CDR and QCD Neon mirrors are AUTHORITATIVE per date. `dedupeAlreadyArchived_` drops whole dates, so the old "partial set" comment was wrong. The bulk report now names the DQE prune step (`previewNeonExtraRows` / `pruneNeonExtraRows`) to run after the upsert.
- PIPE-3: `processNewImport` refuses a source tab whose most common call date is not the tab's date. The check runs before the Raw Data rewrite, the compute and the force-delete, so nothing is deleted or written. It covers CDR, Q Path, QCD and CSR, which all stamp the tab's date.
- PIPE-5: a force Manual Export raises the CR-5 bulk marker for its run. The standalone DQE build (`runDailyDQEBuild_`, cdr-report's trigger) skips its post-write sort while that marker is fresh.
Files modified:
- apps-script/department-dashboard/Alerts.gs
- apps-script/department-dashboard/script-7-admin.html
- apps-script/department-dashboard/Diagnostics.gs
- apps-script/cdr-import/autoImport.js
- apps-script/cdr-import/neonWrite.js and apps-script/cdr-report/neonWrite.js (comments only; byte-identical)
- apps-script/cdr-import/buildDQEHistoricalData.js and apps-script/cdr-report/buildDQEHistoricalData.js (byte-identical)
- tests/unit/alerts-readiness.test.js
- tests/unit/diagnostics-tools.test.js
- tests/unit/csr-transfer.test.js
- tests/unit/pipeline-build.test.js
- CLAUDE.md
- docs/neon-layer.md
- docs/operator-state.md
- docs/next-steps.md
- docs/module-dependencies.md

CHANGES:
ENG-7 f/o | Alerts.gs, script-7-admin.html | `pushAndLog` sets `rec.logFailed = true` on an append failure. The send handler counts these rows; when there are any, it shows a warn status ("…NOT written to the Alert Log… do not send again to rebuild the log") and an error toast that is not sticky (8 s).
ENG-14 f/o | Diagnostics.gs | A missing or empty sheet returns `{ sheetUnavailable, neonReads }` and logs, for a Neon-read install, that this sheet-only trace cannot reproduce the report.
PIPE-1 | autoImport.js, both neonWrite.js | `writeCDRRowsToNeon(..., { authoritative: true })` and `writeQCDRowsToNeon(..., { authoritative: true })` in `processBatchArchive`, with the reasoning corrected. A new bulk-report line names the R37 prune. The neonWrite.js comments no longer list the bulk archive as a partial-set caller.
PIPE-3 | autoImport.js | New pure helper `sourceCallDateCounts_` (col C start-time dates, "M/D/YYYY" or ISO). New `assertSourceDateMatchesTab_` throws "Source date mismatch: …" unless the tab's date has the most calls; a grid with no parseable start time is left to the empty-source handling. It is called right after `cleanData` is built, ahead of every write and delete.
PIPE-5 | autoImport.js, both buildDQEHistoricalData.js | `runManualExport` opens the target workbook, calls `bulkMarkerSet_`, passes that workbook to `processNewImport`, and clears the marker in `finally`. The shared build gains `dqeBulkMarkerFresh_`, using the same key and the same 45-minute staleness rule. It skips the post-write sort when `opts.deferSortWhileBulk` is set and the marker is fresh; `runDailyDQEBuild_` passes that opt.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 2380 tests, 2379 pass, 0 fail, 1 skipped.
- INV-16 guard: in sync.
- module-deps: regenerated, `--check` up to date.
- `lint:gas` (CI=true): clean across 76 files in 3 projects.
- `npm run ci:ui` (CI=true): all stages passed.
- 9 bite checks, all BITE:
  - PIPE-1: 2
  - PIPE-3: 1
  - PIPE-5: 2
  - ENG-7 follow-on: 1
  - ENG-14 follow-on: 1
  - plus the CDR mirror and the Manual Export marker, each separately.

REGRESSION RISKS:
- PIPE-1: if Pending Archive ever held a hand-trimmed or partial set for a date, the authoritative replace would remove that date's other Neon rows. Normal queueing always writes a date's full set.
- PIPE-3: a tab where the previous day's legs outnumber its own date's legs is refused. In practice that means almost no calls on the day, and DQE's F2 already refuses that shape.
- PIPE-5: while a Manual Export runs, cdr-report's 7 AM build appends without sorting; the nightly check sorts the sheet later. Manual Export now opens the workbook before `processNewImport`, which was already its first step.

INVARIANTS AT RISK: None.
- INV-16: both pairs are byte-identical (guard passes).
- IMP-5 / P-6: the authoritative writers are unchanged; only which callers pass the flag changed.
- The force-path ordering rule (P-3 / I-6 / P-1): the new check runs before any write or delete (pinned).
- CR-5: the marker key is held equal across all three readers and writers (pinned).

NET SCORE: 0 − 0 = 0. None of the five is likely to have fired this month: shrinking bulk rebuilds while reading from Neon, mislabeled tabs and the sort race are all rare. The follow-ons are surfacing changes.

OPERATOR ACTIONS / DEPLOY:
- After the next bulk rebuild: backfillDQEHistoryUpsert(), then previewNeonExtraRows() / pruneNeonExtraRows() (cdr-report), as the bulk report now says. | BLOCKS DEPLOY: N
Deploy:
- CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`).
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`.
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f`, then Deploy → Manage deployments → New version).

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- PIPE-3 guards `processNewImport` only. A tab processed by any other entry point that bypasses it is not checked; none was found in this pass.
- The CR-5 marker is still not raised by the daily `autoImport` trigger. That run is not force, so it does not delete, and needs no marker.

DOCUMENTATION UPDATES NEEDED:
- None remaining. Done in this commit:
  - docs/neon-layer.md (the bulk archive is authoritative, plus the prune step);
  - Operator State #61 (PIPE-5);
  - the CLAUDE.md force-path ordering bullet (PIPE-3);
  - the docs/next-steps.md Batch 7 row → IMPLEMENTED (block 253).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
