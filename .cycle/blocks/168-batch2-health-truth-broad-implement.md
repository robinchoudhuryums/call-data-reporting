# Increment 168 — Batch 2 (broad-scan 2026-09-03): make the Health page tell the truth, + Batch 1 follow-ons

---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- O-2 -- the Health page painted the queue report's `LATE` outcome green (classifier keyed on the pre-Round-16 `MISSED`); the gate explainer and Operator State #31 still described a terminal MISSED with no retry
- O-3 / I-8 / C2-5 -- eight failure-only Pipeline Health step names stuck the "Recent pipeline step failures" row red for the whole 250-row window after one transient error
- O-4 -- `*_LAST` ages were never checked (a 6-minute kill skips catch/finally and left the previous "ok" green); CacheWarm's Overview / summaries / qcdAll phases ran with no runtime budget
- O-7 -- two watchdogs could be dead-but-green: DQE-silence wrote `ok (inconclusive ...)`; the ingest watchdog returned on a null read without recording anything and had no Health outcome row
- O-6 -- the Neon coverage email appended the clock-bound (no-sheet-primary) tables LAST, so the line cap cut exactly the perishable findings; the stored result kept only a count
- O-5 -- `ncMissingTableError_` (and NeonBackup's inline copy) classified ANY "does not exist" -- a missing COLUMN (schema drift) -- as "table not created yet"
- O-12 -- a transient sheet read error in the sheet-coverage check reported as sheet MISSING (and a window with only read errors recorded CLEAN)
- O-14 -- the Health page read a `QUEUE_REPORT_LAST` key nothing ever wrote
- Batch 1 follow-ons: I-6 (force-delete preceded the compute stages: a compute throw destroyed the date across five sheets); the backfill sanitizer tally is now visible cross-project via Pipeline Health rows; the EMPTY queue-report outcome names the `COMPANY_HOLIDAYS` exit for a genuinely quiet day
- Not taken from the follow-on list: the redundant `neonWrite.js:432` ISO guard (harmless; left in place)

Files modified:
- apps-script/department-dashboard/SystemHealth.gs, QueueReportEmail.gs, DqeSilenceWatch.gs, IngestWatchdog.gs, NeonCoverage.gs, NeonBackup.gs, SheetCoverage.gs, CacheWarm.gs
- apps-script/cdr-import/autoImport.js (I-6)
- apps-script/cdr-report/neonbackfill.js (Pipeline Health tally rows)
- tests/unit/system-health.test.js, queue-report.test.js, ingest-watchdog.test.js, dqe-silence-watch.test.js, neon-coverage.test.js, sheet-coverage.test.js, csr-transfer.test.js, neon-backfill-resume.test.js, NEW tests/unit/cache-warm-budget.test.js, tests/README.md
- docs/invariants.md (INV-44), docs/operator-state.md (#31)

CHANGES:
O-2 | SystemHealth.gs, QueueReportEmail.gs, docs/operator-state.md | the outcome classifier gains `^LATE\b` (a late SEND leads with "Sent" and stays green); `queueReportGateExplain_`'s not-ready text now says the day is flagged LATE once and the poller KEEPS retrying until midnight; #31's "⚠ renders green until O-2 lands" replaced with the live rule (incl. EMPTY).
O-3 / I-8 / C2-5 | SystemHealth.gs, docs/invariants.md | `HEALTH_FAILURE_ONLY_STEPS_` (the eight names) + `HEALTH_FAILURE_ONLY_MAX_AGE_MS_` (4 days) + `healthFailureOnlyStep_` / `healthAgeMs_`; in the pipe-failures filter a failure-only step whose latest failure is older than the allowance is moved to an "aged out" list named in the row's HINT instead of flagged; a recurring failure re-lands daily and stays flagged; every other step keeps the M1 most-recent-outcome rule. INV-44 now names `:CSR-guard`, the failure-only set, the aging rule, and the new `dqeBackfill` / `dqeUpsert` steps. Chosen over logging success rows: no extra sheet growth (the 250-row window already evicted a DQE row once, LM1), no INV-16 edits, and the aging is testable in one file.
O-4 | SystemHealth.gs | every outcome row carries its trigger handler, `*_ENABLED` flag and an age allowance (daily engines 4 days -- Fri->Tue stays visible; weekly 9; window-gated keep-warm and editor-run smoke/coverage none); an `*_LAST` older than the allowance while the trigger is installed and the flag is on warns STALE with the 6-minute-kill hint. Gated on `installed[fn]` so a disabled engine is reported once (by its svc row), not twice.
O-4 | CacheWarm.gs | `CACHE_WARM_TOTAL_BUDGET_MS` (5 min): the per-dept summary loop and the qcdAll phase check it before each unit of work and count what they skipped (`N summaries skipped on budget`, `qcdAll skipped on budget`); the Insights budget is capped by it. The run now always ENDS by recording.
O-7 | DqeSilenceWatch.gs, IngestWatchdog.gs, SystemHealth.gs | `INCONCLUSIVE — <reason>; state untouched, the next run re-checks` replaces `ok (inconclusive ...)`; the ingest watchdog's null-read path writes `INGEST_WATCHDOG_LAST` + an INCONCLUSIVE result instead of returning silently; new `out-ingestwatch` outcome row; classifier gains `^INCONCLUSIVE\b`.
O-6 | NeonCoverage.gs | `ncEmailResult_` emits the no-sheet-primary tables FIRST (marked CLOCK-BOUND), then the sheet-vs-Neon tables, then probe errors, so the cap cuts the recoverable-later findings; new pure `ncClockBoundSuffix_` appends ` | clock-bound: <table> d1,d2,…` (25 per table) to the stored `NEON_COVERAGE_LAST_RESULT`.
O-5 | NeonCoverage.gs, NeonBackup.gs | both regexes anchored to `relation "…" does not exist`; `column "x" does not exist` is a real failure again.
O-12 | SheetCoverage.gs | `sheetCoverageAssess_` distinguishes `null` (sheet missing) from `undefined` (the read threw -> `readError: true`, not a finding); the runner's summary is `FAILED-READ n sheet read error(s) …` when there are no gaps but a read failed (was CLEAN); the log names READ ERROR rows.
O-14 | SystemHealth.gs | the queue-report outcome row's timestamp key is `null` (the result string carries its own time); the loop tolerates a null `at` key.
I-6 | autoImport.js | `calculateMetricsInMemory` / `calcQcdReport` / `calcCsrReport` now run right after the P-3 source validation and BEFORE the force-delete block (they read only the source grid, the config sheet, QCDR Output and the csr_* named ranges -- none of the deleted sheets); toast step numbers re-sequenced (Core 2/7, Extra 3/7, Transferring 4/7).
follow-on | neonbackfill.js | `nbPipelineRow_` (typeof-guarded on the same-project `logPipelineHealth_`) logs `dqeBackfill` / `dqeUpsert` rows on completion -- `success` clean, `failure` when the T-7 tally excluded cells (notes carry the tally + the sheetRepairs cue) -- and on a batch throw. This is the cross-project channel the Health page's pipe-failures row reads.
follow-on | QueueReportEmail.gs | the EMPTY result text ends with the `COMPANY_HOLIDAYS (Operator State #27)` exit.
tests | (see files) | O-2 LATE warn / Sent-LATE ok; O-14 source pin + no phantom " @ "; O-7 INCONCLUSIVE warn + out-ingestwatch row + the two watchdog drivers; O-3 aged-out vs recent vs normal step + the list<->INV-44 parity pin; O-4 stale/installed/flag/keep-warm matrix + `healthAgeMs_` shapes; O-6 suffix + email ordering under truncation; O-5 column-vs-relation + NeonBackup source pin; O-12 assess + runner FAILED-READ; I-6 source-order pin; the backfill Pipeline Health rows (success / loss / throw); NEW cache-warm-budget.test.js (fast run, budget-hit run still records, budget < ceiling). Two pre-existing fixtures encoded the old behavior and were rewritten: the O-10 not-ready explanation regex (`/MISSED/` -> LATE + keeps retrying) and the D-1 EMPTY text pin (holiday exit added).

TEST RESULTS: passed -- `npm run ci`: 1172 pass / 0 fail (was 1154; +18), INV-16 guard in sync. `npm run ci:ui` (rendered gate): all stages passed locally (92/92, 16/16, 30/30, 14/14, 41/41, 14/14, 20/20).
Regression Scenarios (manual, not walked here -- no live deploy): S20 (Alerts modal: the gate-check explanation text changed), S28/S33 (Pipeline Health: two new step names `dqeBackfill`/`dqeUpsert`), S5/S34 (the DQE build itself is untouched; only processNewImport's stage ORDER changed, pinned by source).

REGRESSION RISKS:
- O-3 aging: a failure-only step that fails ONCE and never recurs silently leaves the flagged set after 4 days (it is still named in the hint). A recurring one re-lands daily. An operator who relied on the red row persisting as a to-do loses that; the Alerts modal's Pipeline Health log is unchanged.
- O-4 STALE: a daily engine that is armed but legitimately idle for more than 4 days (a 3-day holiday weekend plus a Monday holiday = 5 days without a weekday run) will warn STALE until its next run; weekly engines get 9 days. The hint says why.
- CacheWarm budget: on a slow day fewer depts get warmed (the skipped ones take the normal cold path, as the Insights phase already did). The Overview compute itself cannot be budgeted mid-call; a single call over 6 minutes still kills the run unrecorded -- but that run now shows as STALE on the Health page (O-4) instead of green.
- I-6: the compute stages now run on a force re-run BEFORE the delete; if they throw, nothing was deleted (the intended change). The toast step labels moved.
- O-5: an environment whose driver surfaces undefined_table without the `relation "…"` phrase would now report a probe error instead of a clean skip. The pinned JDBC/Postgres message shape has always carried it.
- `dqeUpsert` `failure` rows on a lossy backfill make the pipe-failures row red until a clean run -- by design (the cue to run the sheetRepairs); it is NOT in the failure-only aging list because a clean run logs `success`.

INVARIANTS AT RISK:
- INV-44: extended (new names + the failure-only set); the schema and writers are unchanged. system-health.test.js pins that the entry names every listed failure-only step.
- INV-01: no new public write path; every new helper is `_`-suffixed. `nbPipelineRow_` writes the Pipeline Health sheet from an editor-run backfill in the cdr-report project, the existing append-only convention.
- INV-16: neither paired file touched; guard passes.
- INV-30: no cache key changed.
- OPS-8 prefix coding: two new prefixes (`INCONCLUSIVE`, `LATE` recognized; `FAILED-READ` inherits the `fail` substring).

NET SCORE: 2 − 1 = 1
(a: O-6 YES -- the 2026-09-02 coverage email demonstrably truncated the clock-bound dates; O-2 YES -- the Aug 5-13 reprocess week has had late QCD landings, and any post-noon day rendered green. O-3/C2-5, O-4, O-7, O-5, O-12, O-14, I-6: mechanism live, no confirmed fire this month -> NO. b: one documented new failure mode -- the O-4 STALE false-positive on a legitimately idle armed engine past its allowance.)

OPERATOR ACTIONS / DEPLOY:
- None required before deploy. | BLOCKS DEPLOY: N
- After deploy, expect one-time Health page changes: an old failure-only Pipeline Health row that was red may turn green with an "aged out" hint; any armed engine whose last recorded outcome is older than its allowance shows STALE until it next records. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (SystemHealth / QueueReportEmail / DqeSilenceWatch / IngestWatchdog / NeonCoverage / NeonBackup / SheetCoverage / CacheWarm)
- CDR Import: `scripts/deploy.sh apps-script/cdr-import` (autoImport.js, I-6)
- CDR Reporting Tools: `scripts/deploy.sh apps-script/cdr-report` (neonbackfill.js)

FOLLOW-ON ITEMS:
- O-13 (doc): Operator State #31 still says "QCD is the last historical sheet the import writes" (false; DQE and Direct follow) and NeonKeepWarm.gs:15 quotes the old 190h free tier; SystemHealth.gs:398 says "Four" engines (seven). Batch 7.
- The `neonWrite.js:432` ISO guard is redundant since I2-9 (harmless).
- O-4 cannot bound a SINGLE over-long call (the Overview compute on the sheet-fallback path); that needs the bounded-read work already tracked for `openSpreadsheet_` memoization.
- I-6's sibling: the bulk path (`queueToPendingArchive`) still deletes per date before its own compute in `bulkHistoricalUpdate`? Not verified here -- the daily/manual path was the finding's scope.
- The Alerts modal's Pipeline Health panel (last 20 rows) does not apply the failure-only aging; it is the raw log by design.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md "System Health" bullet: the COROLLARY sentence ("failure-only names stay red until they scroll out of the 250-row window (C2-5, open)") is now false -- replace with the aging rule (`HEALTH_FAILURE_ONLY_STEPS_`, 4 days) and note `dqeBackfill`/`dqeUpsert`.
- CLAUDE.md Force-path guard bullet: mention that the compute stages now precede the force-delete (I-6) alongside P-3.
- CLAUDE.md Report cache warming / Operator State #21: the whole-run budget and the new skipped counts in the outcome string.
- docs/fix-history.md: O-2, O-3/I-8/C2-5, O-4, O-5, O-6, O-7, O-12, O-14, I-6 rows -> live rules (Batch 2, 2026-09-03).
- docs/operator-state.md #23 (ingest watchdog): now has an outcome row and records INCONCLUSIVE; #35 (Neon coverage): the email order + the clock-bound suffix in LAST_RESULT; #44 (DQE silence): INCONCLUSIVE prefix; #52 (sheet coverage): FAILED-READ outcome.
- docs/operator-state.md #31: DONE in this commit. docs/invariants.md INV-44: DONE in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
