---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E4 is an expansion batch -- new capability only)
New capabilities (G/ST):
- ST2 (NARROW, owner ruling 2026-10-15) one day rule: rawGridDay_ / rawGridDayIso_ (cdr-import autoImport.js; byte-identical copy in cdr-report queueOverlapAudit.js, guarded by check-duplicated-files.sh) -- a grid's day is its MAJORITY date, strays split off, undated rows kept -- now used by every stray-aware reader: PIPE-3's tab-date check, the CSR daily engine and repair, diagnoseQcdVsDqe, queueSplitSample and the overlap audit. No stored figure changes: CDR / QCD / Q Path still count carry-over legs, and the DQE / Direct / per-call builders keep their own per-record checks.
- ST5 one shared parity day: tests/harness/parityDay.js drives the real build (both INV-16 copies), the DQE drill, the split sample and the overlap audit, which must agree on the day, the stray, the abandoned columns, the sentinel and the two-queue call; the per-tool suites import its rawRow instead of keeping copies.
Files modified: apps-script/cdr-import/{autoImport.js, qcdDqeDiagnostic.js, queueSplitSample.js}, apps-script/cdr-report/queueOverlapAudit.js, scripts/check-duplicated-files.sh, tests/harness/parityDay.js (new), tests/unit/{raw-grid-day.test.js (new), parity-day.test.js (new), dqe-drilldown-parity, queue-split-sample, queue-overlap-audit}.test.js, tests/README.md, CLAUDE.md, .cycle/STATE.md

CHANGES:
ST2 | autoImport.js | new PURE rawGridDayIso_ (M/D/YYYY, M/D/YY, ISO; null = undated) + rawGridDay_ ({dateIso majority (tie -> later), rows, strays, strayByDay, counts, total}); sourceCallDateCounts_ (PIPE-3) and csrRepairDayRows_ (F64 daily + ING-7 repair) become views over it.
ST2 | qcdDqeDiagnostic.js | F60's Raw Data dating calls rawGridDay_ directly.
ST2 | queueSplitSample.js | the run's date is rawGridDay_'s majority day (was the first valid START_TIME, which an ING-7 carry-over leg can be); per-leg stray check through rawGridDayIso_.
ST2 | cdr-report/queueOverlapAudit.js | the helpers' guarded copy; the audit's day is the majority (was the first valid row); a leg is a stray only when it has a date and it differs (undated rows kept, as the build keeps them); header comments corrected.
ST2 | scripts/check-duplicated-files.sh, CLAUDE.md | two new check_fn_pair lines (rawGridDayIso_, rawGridDay_) and the guard's success line; the Key-commands guard comment names them.
ST2 | tests/unit/raw-grid-day.test.js (new), queue-overlap-audit + queue-split-sample tests | the rule (ING-7, ties, undated, parse shapes), the PIPE-3 / CSR views, and a sweep that every stray-aware reader calls it (and the first-valid loops never return); two overlap-audit fixtures were 1-1 ties encoding the old first-row choice -- now a clear majority; the split-sample suite loads autoImport.js (the same project scope).
ST5 | tests/harness/parityDay.js (new), tests/unit/parity-day.test.js (new) | the shared day + 5 tests: non-degenerate guard, both build copies write identical rows, drill == cell for unique / rung / missed / answered / TTT / AD / AE / AF (+ Bob, + sentinel refusal), split sample OK past a stray sorted first, overlap audit on the same day with the same stray and the two-queue call.
ST5 | dqe-drilldown-parity, queue-split-sample, queue-overlap-audit tests | their private rawRow / raw builders replaced by the shared one.

TEST RESULTS: passed -- 2527 tests, 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean (and bitten by hand: a one-sided edit of the cdr-report copy fails it); module-deps unchanged. Bites 10/10 after re-aiming one (my first drill mutation hit a comment). ci:ui not run: no dashboard or client file changed.
Regression scenarios: S5 / S34 (daily DQE build, integrated import) -- the build and the five history-sheet writes are untouched; PIPE-3 reads the same counts through the shared parser: PASS by inspection. S7 (pipeline numbers match the dashboard): no stored figure changes: PASS by inspection.
REGRESSION RISKS:
- csrRepairDayRows_ parsed dates with parseDateForNeon; the shared rule parses M/D/YYYY, M/D/YY and ISO only. Identical for the display strings Raw Data holds; a shape only parseDateForNeon accepted now reads UNDATED (kept) instead of possibly a stray, which could only ADD a leg to the CSR day, never drop one.
- queueSplitSample and the overlap audit now pick a different day than before only when a carry-over leg sorts first or two dates tie -- both previously wrong or arbitrary.
- The standalone cdr-report DQE build (runDailyDQEBuild_ without expectedDate) still dates by the first valid row -- deliberately left alone (owner ruling); see FOLLOW-ON.
INVARIANTS AT RISK: None. INV-16: buildDQEHistoricalData.js / neonWrite.js untouched, and the new pair is guarded like INV-16's function pairs. INV-06 / INV-07 / INV-08: no build rule moved.
NET SCORE: 0 − 0 = 0 (ST2/ST5 are new capabilities, not production fixes; no new failure mode -- the parse difference above can only keep a row the old parser might have dropped)

OPERATOR ACTIONS / DEPLOY:
- None.
Deploy:
- CDR Import: `scripts/deploy.sh apps-script/cdr-import` (or `cd apps-script/cdr-import && clasp push -f`)
- CDR Reporting Tools (queueOverlapAudit.js): `scripts/deploy.sh apps-script/cdr-report` (or `cd apps-script/cdr-report && clasp push -f`)
- Department Dashboard: no change

FOLLOW-ON ITEMS:
- The standalone cdr-report DQE safety-net build (no expectedDate) dates Raw Data by its FIRST valid row, so in the ING-7 shape it resolves to the carry-over leg's day. Its dup guard then finds that day already built and skips (re-mirroring it), so the real day is not mis-written -- but moving it to rawGridDay_ would be an INV-16 edit in both copies, held back with the narrow ST2 ruling.
- The QCD Extraction Sidebar and the CDR / QCD / Q Path engines keep counting carry-over legs -- by ruling; revisit only if the owner wants carry-over legs out of the stored queue figures (the "Full" option).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
