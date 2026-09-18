---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- P-1 | Force re-import's Raw Data rewrite + output-sheet writes sat between the five-sheet delete and the historical writes
- P-3 | Two execution ceilings assumed (30 min vs 6 min); budgets not alignable without a redeploy -- measured now
- P-2 | Deferred mirror's retry cap dropped a date whose inbound/outbound source was pruned, taking the sheet-derivable mirrors with it; attempts counted during outages
- P-6 | Transfer-path preview logged the external caller's CNAM verbatim
- P-9 | DDL ran inside every write transaction (ACCESS EXCLUSIVE held to COMMIT)
- P-13 | Clear Pending Archive could discard the only copy of force-deleted dates without saying so
- P-7 | DQE build never date-filtered legs; a D-1 carry-over leg entered AD/AE/AF and picked the build date
- DD-4 | Sentinel rings outside the 18 chart slots counted but were not charted or explained
- P-4 | neonSqlLit_ tag check missed a value ENDING in the tag
- P-12 | Two date resolvers for the same history cells (script-TZ toDateString vs sheet-TZ display)
- DD-7 | Nightly sort's single-typed gate admitted an all-TEXT date column (lexical sort)
- P-8 | Raw Data staging coerced whitespace to 0
- P-11 | Journey masking was phone-shape-only; an external callee's CNAM name reached the journey
- OD-6 | NeonCoverage's date parser was narrower than the readers' and dropped rows silently

Files modified:
- apps-script/cdr-import/autoImport.js
- apps-script/cdr-import/NeonMirror.js
- apps-script/cdr-import/inboundCalls.js
- apps-script/cdr-import/outboundCalls.js
- apps-script/cdr-import/neonWrite.js + apps-script/cdr-report/neonWrite.js (INV-16 twin)
- apps-script/cdr-import/buildDQEHistoricalData.js + apps-script/cdr-report/buildDQEHistoricalData.js (INV-16 twin)
- apps-script/cdr-import/execCeilingProbe.js (NEW) + apps-script/cdr-import/CDR Tools.js (menu)
- apps-script/cdr-report/sheetRepairs.js
- apps-script/department-dashboard/MissedCallsReport.gs, script-5-dept.html
- apps-script/department-dashboard/NeonCoverage.gs
- CLAUDE.md (Subsystems: the new cdr-import file), tests/README.md
- tests/unit/exec-ceiling-probe.test.js (NEW); csr-transfer, neon-mirror-tail, neon-write-mapping, inbound-calls, outbound-calls, pipeline-build, missed-report, historical-sort, neon-coverage

CHANGES:
P-1 | autoImport.js | `isHistoricalBackfill` / `willBuildDQE` (= `force || !existsInDQE`) / `willBuildDirect` / `needsRawDataWrite` are computed from the PRE-delete flags; the Raw Data staging rewrite and both output-sheet writes now precede `if (force) { ... deleteHistoricalRowsForDate ... }`. Pinned by csr-transfer "P-1" (source order).
P-3 | autoImport.js, inboundCalls.js, execCeilingProbe.js, CDR Tools.js | `bulkTimeLimitMs_()` reads `BULK_TIME_LIMIT_MS` (default 900000, bounded 1-40 min); `icBackfillTimeLimitMs_()` reads `IC_BACKFILL_TIME_LIMIT_MS` likewise. New probe: `installExecCeilingProbeTrigger` (one-shot time trigger -> `runExecCeilingProbe_`, which sleeps in 10 s steps writing `EXEC_CEILING_PROBE_LAST_MS` until killed or 40 min), `readExecCeilingProbe` + the pure `execCeilingVerdict_` (KILLED -> ceiling + a recommended budget of ceiling minus ~2 min; ABOVE-MAX; RUNNING; NO-DATA). The bulk comment no longer asserts a 30-min ceiling and documents that Resume re-runs the in-flight date.
P-2 | NeonMirror.js | `mirrorInboundForDate_` / `mirrorOutboundForDate_` return `{ pruned: true, note }` instead of throwing when `sheetsFound === 0`; `neonMirrorDate_` logs a pruned type as a `neonMirror:<Type>` failure row ("SOURCE PRUNED ... terminal; not retried"), keeps `allOk`, and emails ONCE when the date completes; a thrown aggregate error carries `neonUnreachable` when any step was unreachable, and `runNeonMirror_` then leaves the date queued WITHOUT counting an attempt or emailing.
P-6 | inboundCalls.js (previewInternalTransferPaths) | the caller CNAM is captured through `cdrMaskExternalName_` (initials) or `(external caller)` before it can reach the PATH log line.
P-9 | neonWrite.js (both copies), inboundCalls.js, outboundCalls.js | `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX` execute in AUTOCOMMIT; `conn.setAutoCommit(false)` moves to just after the DDL block, so the DELETE + INSERT remain one transaction. Pinned by an ordering conn in each writer suite.
P-13 | autoImport.js | new pure `pendingOnlyCopyDates_(pendingMeta, histSets, tz)`; `clearPendingArchive` refuses while `bulkIndex` is set, and its prompt names the row/date counts and the dates with NO rows in their history sheet (the only copy).
P-7 | buildDQEHistoricalData.js (both copies) | with `opts.expectedDate`, the build date is the first row ON that day (a stray D-1 leg no longer picks it; zero matching rows still hit the F2 refusal); after date detection, legs on any other calendar day are dropped from `data`/`timeVals` in lockstep with a `DQE (P-7): dropped N stray leg(s)` log line. Read side deliberately UNCHANGED: RPT-1 (an owner ruling) counts AD ids before the slot check, so the source is cleaned rather than the ruling reversed.
DD-4 | MissedCallsReport.gs, script-5-dept.html | `target.outOfRange++` when `bucketIdx === -1`; carried on each `queueOnly[]` card; the card summary appends "(N outside 8 AM–5 PM, not charted)". No INV-30 bump (additive disclosure).
P-4 | neonWrite.js (both copies) | `while ((s + '$').indexOf('$' + tag + '$') !== -1) tag += 'x';`. Pinned incl. the trailing-tag and the `$nqx`-suffix cases.
P-12 | autoImport.js | `historyDateKey_(dateObj, tz)` / `historyCellIso_(display, tz)` / `historySheetTz_()`: `checkHistoryForDate`, `buildHistoryDateSet`, `deleteHistoricalRowsForDate`, `dedupeAlreadyArchived_` and the bulk `histDateCache` key all read DISPLAY values and key the SPREADSHEET-TZ day. The R46 shape (a script-midnight Date) now keys the day the sheet shows, matching the writer, the dup-guard and the census.
DD-7 | sheetRepairs.js | `res.dateTyped` (single-typed AND the type is `date`/`serial`); `runHistoricalSortCheck_` refuses an out-of-order all-text column with `UNSORTED+TEXT-TYPED` and a failure row naming the lexical-sort trap; never sorts it.
P-8 | autoImport.js | `stageRawDataCell_`: numbers pass through, whitespace-only -> '', only `^[-+]?\d+(\.\d+)?$` strings become Numbers.
P-11 | inboundCalls.js (icBuildJourney_) | a non-queue leg whose CALLEE number is external carries `cdrMaskExternalName_(name)` (initials) or `(external caller)`; internal callees keep their names.
OD-6 | NeonCoverage.gs | `ncCellDateIso_(s, tz)` delegates to `rowDateIso_` when Data.gs is in scope (falls back to the two sheet renders otherwise); `ncSheetDateCounts_` tallies unparsed cells (non-enumerable `_unparsed`) and the runner reports them as their own probe error ("run previewHistoricalDateColumns()"), never as a Neon phantom.

TEST RESULTS: passed -- `node --test` 1641/1641 under TZ=America/Chicago (22 new tests + the IMP-11 test rewritten to the P-2 contract; the new `exec-ceiling-probe` suite is listed in tests/README.md). INV-16 guard clean (both twins mirrored byte-for-byte). `npm run lint:gas` clean (73 files) -- it is what the harness cannot see: a stale `targetStr` reference in a log line was caught by a test first and would have been caught by lint. Bite-checks (scripts/bite.sh): P-1 order, P-2 pruned terminal, P-7 stray filter (on the cdr-report copy the suite loads), P-9 DDL-in-txn, P-12 sheet-TZ key, DD-4 overflow, DD-7 text-typed, OD-6 tally -- all BITE. `npm run ci:ui` not required (the one client change is a summary suffix in a queue-only card; the harness has no sentinel fixture) -- run it as part of deploy.sh's gate. NOTE for the harness: the full suite must run under TZ=America/Chicago as CI does; without it the P-12 pins (midnight Date fixtures) read a different day.

REGRESSION RISKS:
- P-12 changes the KEY every history-date check uses. For a correctly written cell (sheet-midnight Date, M/D/YYYY text) and a noon importer date the key is identical to before. For an R46-shaped cell (script-midnight Date on a summer date) the force-delete and exists-check now key it the way the sheet displays it (the previous day) -- the same day the dup-guard and census already used -- so a force re-import of such a date deletes what those readers consider that date. This is the intended convergence; `repairDqeDateNormalize()` remains the remedy for the cells themselves.
- P-7: a legitimately mixed-day Raw Data grid (a re-import whose sheet holds two days) now builds ONLY the expected/first day and logs the rest; previously it refused (with expectedDate) or wrote a mis-dated set (without). Strays are logged, not written, so nothing silent changed.
- P-2: a date whose ONLY problem is a pruned per-call source now dequeues (with a failure row + one email) instead of parking at the retry cap; operators lose the repeated `gave-up` email for that case and gain the one-time SOURCE PRUNED email.
- P-9: the DDL now commits on its own before the write transaction; a DDL failure still surfaces through the same catch (rollback is a wrapped no-op in autocommit). A CREATE TABLE that succeeds followed by a failed write leaves the (empty) table -- harmless and idempotent.
- P-1: on a force run, Raw Data and the output sheets are rewritten before the delete; if the delete then throws, the output sheets already show the new day (previously they would not have been touched). The historical sheets are untouched in that case, which is the point.
- P-8: a cell like `1e3` or `0x10` no longer coerces to a Number (stays text). The CDR feed carries plain decimals and H:MM:SS strings; nothing in the build parses exponent forms.
- P-11: an external callee's CNAM is now initials; the journey renderers print `name` verbatim, so the drill shows "S.J." where it showed a name.
- OD-6: NeonCoverage now accepts `M/D/YY` and Date/serial-shaped display strings the readers accept; a previously "extra-in-neon" finding for such rows disappears, replaced (when a cell is truly unparseable) by a probe error naming the repair.

INVARIANTS AT RISK: None. INV-16 (both twins mirrored; guard clean). INV-02 (durations still via display values; P-12 adds display-value DATE keys, the F-3/F-10 rule). INV-06/07/08/20/21 (the build's per-agent rules untouched; P-7 only narrows the input rows to one day -- pipeline-build's existing pins green). INV-23 (sentinel rows still emitted; DD-4 is read-side disclosure). INV-30 (no aggregation-rule change: DD-4 adds a field; OD-6 is a diagnostic). INV-44 (`neonMirror:<Type>` rows keep their names; the pruned note rides in the existing row).

NET SCORE: 9 − 0 = 9
(a: would have fired this month -- P-1 NO (no throw seen in that window), P-3 NO (measurement tool), P-2 YES (a pruned backlog date is the documented IMP-11 path), P-6 YES (every preview run), P-9 YES (every mirror while DQE_READ_SOURCE=neon), P-13 NO, P-7 YES (the F2 refusals were this shape), DD-4 YES (CSR sentinels ring past 5 PM), P-4 NO, P-12 YES (latent until an R46 cell, which the census has found), DD-7 NO, P-8 YES (blank-ish CSV cells), P-11 YES (forwards to external numbers), OD-6 YES (the census reports TZ-split cells); b: new failure mode -- NO for all 14.)

OPERATOR ACTIONS / DEPLOY:
- Measure the execution ceiling ONCE after deploying cdr-import: CDR Tools -> "Measure execution ceiling (one-shot probe)", wait ~45 min, then "Read execution-ceiling probe result" and set `BULK_TIME_LIMIT_MS` / `IC_BACKFILL_TIME_LIMIT_MS` (cdr-import Script Properties) to the recommended value if the ceiling is 6 min. Until then the defaults (15 min) are unchanged. | BLOCKS DEPLOY: N
- No rebuild needed for P-7 (future builds only; a stray already in AD/AE/AF stays until that date is rebuilt). | BLOCKS DEPLOY: N
Deploy: CDR Import -- `cd apps-script/cdr-import && clasp push -f` (autoImport, NeonMirror, inboundCalls, outboundCalls, neonWrite, buildDQEHistoricalData, execCeilingProbe (NEW), CDR Tools menu). CDR DQE Pipeline / CDR Reporting Tools -- `cd apps-script/cdr-report && clasp push -f` (neonWrite, buildDQEHistoricalData, sheetRepairs). Department Dashboard -- `scripts/deploy.sh . <dashboard-deployment-id>` (MissedCallsReport.gs, NeonCoverage.gs, script-5-dept.html).

FOLLOW-ON ITEMS:
- P-7 read side: `MissedCallsReport.gs` still counts AD ids before the slot check by the RPT-1 owner ruling; if the owner wants out-of-window abandons out of the headline too, that is a ruling change, not a fix.
- P-3: `NEON_MIRROR_BUDGET_MS` (default ~4 min) already assumes 6 min; if the probe reads 30 min the deferred drain could be given more budget per run.
- The `direct_call_history` writer (`directCallMetrics.js`) still runs its `CREATE TABLE IF NOT EXISTS` inside the transaction; not in this batch's three writers and a no-op lock on an existing table, but the same P-9 shape.
- cdr-import Script Properties (`BULK_TIME_LIMIT_MS`, `IC_BACKFILL_TIME_LIMIT_MS`, `EXEC_CEILING_PROBE_*`) have no registry like the dashboard's `PROP_REGISTRY_`; the operator-state item below is the only inventory.
- Batches 6-9 of the scan plan remain.

DOCUMENTATION UPDATES NEEDED:
- docs/operator-state.md: a new item (#70) for the execution-ceiling probe + the two tunable budgets; #22 (deferred mirror) should mention the P-2 pruned terminal and the unreachable-does-not-count rule; #43 (retention prune) can point at the SOURCE PRUNED email.
- CLAUDE.md: the "Deferred Neon mirror" bullet's "a date is LEFT QUEUED on any unreachable/failed step" sentence gains the P-2 clause; the "Neon write discipline" bullet gains one line for P-9 (DDL in autocommit before the txn); the coercion bullet's "New writer-side date comparisons must compare ISO-NORMALIZED DISPLAY values" is now what the history resolvers do (P-12) -- name `historyCellIso_`; INV-44 note for the SOURCE PRUNED row text is optional.
- docs/fix-history.md: add the Batch 5 codes to the 2026-09-17 section.
- docs/known-issues.md "6-minute ceiling" statements: mark as "measure with the probe" rather than asserted.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
