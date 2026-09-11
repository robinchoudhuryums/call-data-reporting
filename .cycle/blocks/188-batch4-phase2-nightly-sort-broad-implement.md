---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Batch 4 / Phase 2 | Nightly check-and-sort over the five historical sheets: flag-gated cdr-report trigger (`runHistoricalSortCheck_`, `HISTORICAL_SORT_ENABLED`, CDR Tools install/uninstall/preview/run-now); per sheet the census scan ("single-typed AND ordered AND no TZ split"), sort ONLY a single-typed out-of-order column on its own date column, re-check, REFUSE mixed / TZ-split / unparsed with a failure row; defers while any backfill `*_RESUME` pointer is set; one `historicalSort:<DQE|QCD|CDR|CSR|QPath>` Pipeline Health row per sheet per run
- Batch 4 / Phase 2 | Health page `historical-sort` row (SystemHealth.gs) from the latest `historicalSort:*` row per sheet: muted (no rows / skipped), ok (none needed sorting), warn (needed sorting = a writer appending out of order; could not fix = a repair, not a sort)
- Batch 4 / Phase 2 | The bulk path's swallowed sort failure (`processBatchArchive`, `console.warn`) is now a Pipeline Health FAILURE row under the same step name, superseded by the next clean nightly run
- Follow-on (roadmap → Batch 4) | The census's TZ-SPLIT predicate is memoized per distinct instant (`hdScanOneSheet_`, + a `skipFormats` option for the nightly path)
- Follow-on (roadmap → Batch 4) | `parseDateForNeon` refuses a BARE NUMBER (a serial under a numeric format read as the year 45726 before); the census's private copy of that guard is gone
- Follow-on (roadmap, dashboard ride-along) | `drive-smoke.js` clicks the Queue Call Data card's Yesterday / MTD / Range toggle (four rendered checks per role)

Files modified:
- apps-script/cdr-report/sheetRepairs.js (Phase 2 engine + census memo/skipFormats/resolver hand-off), apps-script/cdr-report/CDR Tools menu.js
- apps-script/cdr-report/neonWrite.js + apps-script/cdr-import/neonWrite.js (INV-16 pair)
- apps-script/cdr-import/autoImport.js
- apps-script/department-dashboard/SystemHealth.gs
- tests/harness/fakeSheet.js (Range.sort MODELLED: numbers/Dates, then text, blanks last; `_sortCalls`, `_sortError`)
- tests/unit/historical-sort.test.js (NEW, 15 tests), tests/unit/historical-date-columns.test.js (+3, one expectation updated for the modelled sort), tests/unit/system-health.test.js (+5), tests/unit/neon-write-mapping.test.js (+1), tests/README.md
- tools/ui-harness/drive-smoke.js
- CLAUDE.md (new bullet; Operator State index #61), docs/invariants.md (INV-44), docs/operator-state.md (#61), docs/next-steps.md (Batch 4 SHIPPED; three follow-ons struck), docs/date-column-normalization-plan.md (Phase 2 SHIPPED + as-built), .cycle/STATE.md

CHANGES:
B4-engine | sheetRepairs.js | `historicalSortCheck_({apply})`: resume-pointer deferral (six `*_RESUME` props) → per-sheet skipped rows without a read; else `hdScanOneSheet_(ss, spec, {skipFormats:true})` → CLEAN / MISSING / EMPTY success; `singleTyped && !tzSplit && !unparsed && !ordered` → `hsSortSheet_` (range from row 2, full width, `column: dateCol`) + re-scan (CLEAN → "sorted -- N inversion(s) (first at row R: a then b)"; else failure); anything else → REFUSED failure naming the verdict; a throw costs that sheet only; `logPipelineHealth_` per sheet when applying. `runHistoricalSortCheck_` gates on the flag (trim/lower); `previewHistoricalSortCheck` never writes; `installHistoricalSortTrigger` creates the daily 3 AM trigger AND sets the flag, uninstall deletes both
B4-health | SystemHealth.gs | `historical-sort` row after pipe-failures, sharing its `phRows` scan window; branches: none → muted install hint; any failure → warn "could not fix: <sheet> (<notes head>)"; any `sorted` → warn "needed sorting"; all `skipped` → muted; else ok "N sheet(s) checked, none needed sorting"
B4-bulk | autoImport.js | the `sheetsToSort` catch logs `historicalSort:<label>` failure via `logPipelineHealthWithFallback_(targetSS, …)` (log, never throw); labels CDR / QPath / QCD / CSR match the nightly check's so its success row supersedes
B4-memo | sheetRepairs.js | `tzMemo[instant] = {sheet, script}` — 2 formatDate calls per distinct instant, not per row; `res.formats = null` when `skipFormats`
B4-serial | neonWrite.js ×2 | `if (/^-?\d+(\.\d+)?$/.test(s)) return null;` before the `new Date(s)` fallback; the census calls the resolver directly
B4-smoke | drive-smoke.js | in-page clicks on `#dept-qcd-period` (mtd → range → yesterday): bar + Range shown and Yesterday default; MTD title "Month to date"; Range title carries "→"; Yesterday restores title + tiles
Harness | fakeSheet.js | `sort(spec)` orders the range's rows by the absolute column with Sheets' type grouping, moves `_displays`/`_formats` in lockstep, records `_sortCalls`, throws `_sortError` once; stale "sort stays a no-op" comment replaced

TEST RESULTS: passed -- `node --test` 1351/1351 (1327 + 24 new); INV-16 guard in sync; claude-md-split pins green (bullet + index #61 + INV-44 + README map). Mutations 18/18 killed: sorts a MIXED column; sorts a TZ-SPLIT column (needed an out-of-order TZ-split fixture -- survived once, fixed); flag gate removed; preview applies; resume deferral removed; no Pipeline Health row; re-check dropped (needed a re-check-fails case via a second-scan stub -- survived once, fixed); memo removed; resolver serial guard removed (3 tests); bulk catch back to console.warn; Health sorted→ok; Health failures not surfaced; Health skipped→ok; install forgets the flag; uninstall keeps the flag; label drift QPath→"Q Path" (4 tests); fake sort stops reordering; sort on the wrong column (2 tests). `npm run ci:ui`: all eight stages green (102/16/30/14/52/14/20 checks, exit 0), incl. the four new Queue Call Data checks for BOTH roles with rendered evidence -- Yesterday -> "Month to date (since Sep 1)" -> "9/10 → 9/10" -> restored byte-for-byte. Regression Scenarios overlapping modified files: S5 / S7 / S28 / S33 / S34 (pipeline + Pipeline Health rows) -- NOT APPLICABLE here: live walks after the three pushes; Operator State #61 is the post-install verification (the first night's rows + the Health row).

REGRESSION RISKS:
- The nightly job sorts a live sheet in place (no 1b snapshot -- whole rows move, no cell is lost, and the DQE build already sorts nightly). A sort during a concurrent daily append could interleave; it runs at 3 AM, four hours before the 7 AM imports, and a re-check that still fails is a failure row, never a claimed success.
- The harness now MODELS `Range.sort`: every existing suite passed on the flip (one R46 expectation had encoded the no-op and was corrected to date order), but a future test that indexes rows after a sorting writer must filter by key (CLAUDE.md bullet says so).
- `parseDateForNeon('45726')` is now null for all ~30 callers; no caller ever meant a bare number as a date (a Date object stringifies as a weekday string, never digits), and the census already refused it.
- The Health row and pipe-failures both flag a failing `historicalSort:*` row (deliberate: pipe-failures stays the complete signal; this row says what it means). Until the check is INSTALLED, a bulk-path sort failure stays flagged there -- correct, the sheet is out of order.
- `HISTORICAL_SORT_ENABLED` is a cdr-report property: the dashboard's `svc()` readiness check cannot see its trigger, so the Health row's muted "no rows" state is the readiness signal (documented in #61).

INVARIANTS AT RISK: INV-44 (a new step family -- entry updated; NOT failure-only, so `HEALTH_FAILURE_ONLY_STEPS_` is unchanged and system-health's INV-44 name check still holds); INV-16 (neonWrite.js pair byte-identical, guard clean); INV-01 (no dashboard write path added -- the engine is cdr-report editor/trigger code, not RPC); INV-02 (the check reads DISPLAY values through the census, `getValues` only for the type); the 1b backup rule (a sort is not a cell rewrite -- stated in the code and #61; the backup source pin's apply list is unchanged). None violated.
NET SCORE: 2 (the bulk-path sort failure that was invisible; the resolver's year-45726 read on any bare-number cell) − 0 = 2

OPERATOR ACTIONS / DEPLOY:
- Push cdr-report, then CDR Report → CDR Tools → ⏰ Nightly Historical Sort Check → Install (creates the trigger + sets `HISTORICAL_SORT_ENABLED`); run Preview first to see what tonight would do | BLOCKS DEPLOY: N (the code is inert until installed)
- First OAuth consent may be needed for `ScriptApp` triggers in cdr-report if never granted (Operator State #9) | BLOCKS DEPLOY: N
- Next morning: the Health page's `historical-sort` row should read ok (or name the sheet that needed its first sort -- CSR Transfer and Q Path were UNSORTED on 2026-09-11's census and will be fixed on the first run) | BLOCKS DEPLOY: N
- Batch 5's gate clock ("Phase 2 live ≥ 2 weeks, quiet") starts at that install | BLOCKS DEPLOY: N
Deploy: CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`; CDR Import: `cd apps-script/cdr-import && clasp push -f` (the neonWrite.js pair + the bulk-path row); Department Dashboard: `clasp push -f` from repo root + new version (the Health row; carries the Batch 2/3 constants too).

FOLLOW-ON ITEMS:
- Carried (unbatched, outside this batch's files): the qcd-report `delete` leak; `getDeptQueueExts_` reading A–D instead of C+D; the all-dept QCD budget being per-run; `IndividualReport.gs` `activeDays` vs `daysActive` (next IR change); rendered coverage for the three REPORT modals (needs gen-phase3 fixtures).
- The nightly check re-reads the date column of all five sheets (~32k rows on DQE) every night; if the 3 AM run ever nears the 6-min ceiling, `HISTORICAL_DATE_COLUMNS_` could be split across two triggers -- no measurement suggests it yet.
- A sorted-but-re-check-fails night (a concurrent append) is a failure row; if it ever fires, the fix is scheduling, not the check.

DOCUMENTATION UPDATES NEEDED:
- None outstanding -- CLAUDE.md bullet + index #61, INV-44, Operator State #61, next-steps.md, the plan doc's Phase 2 status + as-built, tests/README all updated in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
