# Increment 167 — Batch 1 (broad-scan 2026-09-03): wrong numbers leaving the system

---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- D-1 / O-1 -- the all-departments Daily Queue Report could cache a pre-ingest EMPTY payload for 6h, email it to every subscriber, and mark the day sent
- I2-9 / I-5 -- `parseDateForNeon` parsed an ISO-shaped cell as UTC midnight (one day early in Chicago) at ~13 sheet-fed call sites; `displayToDate` refused the same shape
- T-8 -- the four backfill `*_RESUME` pointers were positional row indexes (a row deleted above the pointer skipped rows for good)
- T-7 -- the DQE backfills nulled / sentineled coerced cells silently

Files modified:
- apps-script/cdr-report/neonWrite.js + apps-script/cdr-import/neonWrite.js (INV-16 pair, byte-identical)
- apps-script/cdr-report/buildDQEHistoricalData.js + apps-script/cdr-import/buildDQEHistoricalData.js (INV-16 pair)
- apps-script/cdr-report/neonbackfill.js
- apps-script/department-dashboard/QCDReport.gs, QueueReportEmail.gs, SystemHealth.gs
- tests/unit/queue-report.test.js, qcd-report.test.js, neon-write-mapping.test.js, pipeline-build.test.js, cache-version-sync.test.js, NEW tests/unit/neon-backfill-resume.test.js, tests/README.md
- docs/operator-state.md (#56 + the #19 upsert note)

CHANGES:
D-1 / O-1 | QCDReport.gs | `qcdAllDeptCachedData_(from, to, opts)`: the key gains a freshness ANCHOR suffix -- the latest QCD date via the new `qcdAllFreshnessAnchor_()` (source-aware `getLatestDataDates().qcd`, falling back to the trigger-safe `queueReportQcdLatestIso_()` sheet scan when the RPC's signed-in gate throws, then 'na'); an EMPTY payload (`depts.length === 0`) is served but never PUT; `opts.fresh` skips the cache READ but still warms the key.
D-1 / O-1 | QueueReportEmail.gs | `sendQueueReportForDate_` passes `{fresh: isPreview}` and REFUSES an empty payload: the trigger path returns `{emptyReport: true, reason}` (nothing sent), the single-address preview THROWS "Not sent: ..." so the admin sees it in the modal; `runDailyQueueReport_` records `EMPTY <iso> ...` in `QUEUE_REPORT_LAST_RESULT` and does NOT claim `QUEUE_REPORT_LAST_SENT`, so the next poll retries; `sendQcdAllDeptToSubscribers` throws the same reason instead of returning "0 sent".
D-1 / O-1 | SystemHealth.gs | the queue-report outcome classifier gains the `^EMPTY\b` needs-attention arm (the O-9 NO-SUBSCRIBERS shape).
I2-9 / I-5 | neonWrite.js (both copies) | `parseDateForNeon` returns `yyyy-mm-dd` (and `yyyy-mm-dd <time>`) VERBATIM before the `new Date()` fallback; a 'T'-joined ISO instant still goes through the TZ conversion. Fixes all ~13 call sites at once (neonbackfill x5, sheetRepairs, NeonMirror x2, directCallMetrics x3, autoImport x3).
I2-9 / I-5 | buildDQEHistoricalData.js (both copies) | `displayToDate` accepts an ISO-shaped display as a LOCAL date; the build canonicalizes `callDateStr` to `M/D/YYYY` in that case so col B never RECEIVES ISO text (the cell shape both traps grow from).
T-8 | neonbackfill.js | new `nbResumeRead_` / `nbResumeWrite_` / `nbResumeKey_` + per-sheet key columns (`NB_DQE_KEY_COLS_` [B,C], `NB_CDR_KEY_COLS_` [C,D,E], `NB_QCD_KEY_COLS_` [C,D,E]); every `*_RESUME` write (time-limit + batch-failure, 8 sites) stores `{index, rowCount, key}`; a read whose row count or resume-row key differs -- or a legacy bare integer -- restarts from 0 with a log line saying why. Applied to DQE_BACKFILL / DQE_UPSERT / CDR_BACKFILL / QCD_BACKFILL.
T-7 | neonbackfill.js | new `nbSanitizeDqeCells_` routes the K-AC slots, AD/AE and AF through the unchanged sanitizers while tallying nulled / sentineled cells and rows-with-loss; both DQE backfills log the tally (`nbSanTallyLog_`, with the sheetRepairs runbook when non-zero) and store `OK|PARTIAL <ts> upserted=N cells nulled=.. sentineled=.. rows-with-loss=..` in `DQE_UPSERT_LAST` / `DQE_BACKFILL_LAST`.
tests | queue-report.test.js | nine `depts: []` compute stubs rewritten to carry one dept (they encoded the pre-D-1 state); five new D-1 pins (trigger-path emptyReport, preview throw + `fresh`, `runDailyQueueReport_` EMPTY + no marker, subscriber blast throws, classifier arm incl. a source pin on SystemHealth.gs). qcd-report.test.js: four cache pins (empty never cached, anchored key + anchor-moves-mints-new-key, trigger-context fallback anchor, fresh). neon-write-mapping.test.js: I2-9 pins. pipeline-build.test.js: ISO START_TIME builds and col B is M/D/YYYY. cache-version-sync.test.js: qcdAll anchor classification text. NEW neon-backfill-resume.test.js (9 tests): resume/restart matrix through the real `backfillDQEHistoryUpsert` with a recording JDBC fake, the CDR/QCD key columns, the T-7 tally.

TEST RESULTS: passed -- `npm run ci`: 1154 pass / 0 fail (was 1134; +20), INV-16 guard in sync. `npm run ci:ui` (rendered gate): see the run note below the block.
Regression Scenarios (manual, not walked here -- no live deploy in this session): S20 (Alerts preview + send flow: the preview now throws "Not sent" on a pre-ingest day -- expected), S28/S33 (Pipeline Health rows unchanged), S5/S34 (DQE build: only the ISO START_TIME branch changed; the M/D/YYYY path is byte-identical and pinned).

REGRESSION RISKS:
- A genuinely zero-activity business day (every mapped queue at 0 calls, not in COMPANY_HOLIDAYS) now never sends and shows `EMPTY <iso>` as needs-attention all day, where it used to email "No queue activity recorded" and mark the day sent. Deliberate: that email is indistinguishable from the pre-ingest failure, and the Health page now says so.
- The qcdAll key changes shape (`:<src>:<anchor>` suffix): the first request after deploy is a cache miss (one cold compute); no INV-30 version bump needed (aggregation unchanged; cache-version-sync's anchor spec updated).
- Existing bare-integer `*_RESUME` values restart their backfill from 0 once (logged). Every backfill is ON CONFLICT idempotent, so the only cost is time.
- `parseDateForNeon` on a `yyyy-mm-dd <time>` string previously TZ-converted; now returns the date part. No caller passes a wall-clock ISO string with a time that should shift days, and the `T`-instant form is excluded on purpose.
- `displayToDate` accepting ISO means an ISO-formatted Raw Data START_TIME column now BUILDS instead of refusing the day; col B is canonicalized so no ISO text is written.

INVARIANTS AT RISK:
- INV-16: both pairs re-verified byte-identical (guard passes).
- INV-30: `qcdAll:v6` keeps its version; the key gains two suffix dimensions (read source was already there; the anchor is new). The ANCHOR_SPECS classification was updated in the same commit.
- INV-01: no new public write path; `qcdAllFreshnessAnchor_` / the `nb*_` helpers are `_`-suffixed.
- INV-44: unchanged (EMPTY is a `QUEUE_REPORT_LAST_RESULT` prefix, not a Pipeline Health step).

NET SCORE: 0 − 1 = −1
(a: none of the four is confirmed to have FIRED this month -- D-1's mechanism is live but no empty email was reported; I2-9 needs an ISO-text col B cell; T-8 needs a stale pointer across a row deletion, which the runbook told the operator to avoid by clearing; T-7 is observability. b: one documented new failure mode, the zero-activity-day EMPTY hold above.)

OPERATOR ACTIONS / DEPLOY:
- None required before deploy. After deploy, any in-flight `*_RESUME` pointer (bare integer) restarts its backfill from the top -- run it again as usual. | BLOCKS DEPLOY: N
- Read `DQE_UPSERT_LAST` after the next `backfillDQEHistoryUpsert()` (Operator State #56); a non-zero nulled/sentineled figure is the cue for the sheetRepairs. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (QCDReport.gs / QueueReportEmail.gs / SystemHealth.gs)
- CDR Reporting Tools + CDR DQE Pipeline (same project): `scripts/deploy.sh apps-script/cdr-report` (neonWrite.js, buildDQEHistoricalData.js, neonbackfill.js)
- CDR Import: `scripts/deploy.sh apps-script/cdr-import` (neonWrite.js, buildDQEHistoricalData.js)

FOLLOW-ON ITEMS:
- `DQE_UPSERT_LAST` / `DQE_BACKFILL_LAST` live in the cdr-report project's Script Properties, which the dashboard's Health page cannot read -- surfacing the tally there needs a cross-project channel (the Pipeline Health sheet is the existing one).
- The `neonWrite.js:432` ISO guard on the authoritative CDR DELETE is now redundant with I2-9 (kept, harmless).
- A zero-activity business day holds at EMPTY all day (see risks); if that is too loud, a `COMPANY_HOLIDAYS` nudge in the EMPTY text or an end-of-window "send anyway" rule is the next step.
- I-6 (force-delete precedes compute) is still open and matters while the Aug reprocess runs -- Batch 3.
- O-2 (`LATE` painted green in the same classifier) is Batch 2; the EMPTY arm was added next to the spot it will need.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md "Bulk DQE rebuild skips the per-date Neon mirror" bullet: "Resumable via `DQE_UPSERT_RESUME`" -> note the T-8 fingerprint (one clause) and the T-7 `DQE_UPSERT_LAST` tally.
- CLAUDE.md Key Design Decisions, CacheService tiers: the qcdAll entry ("6h ... trade-off: a rare mid-day force re-import's corrections can lag") -> now anchored on the latest QCD date + never caches empty.
- docs/fix-history.md: D-1/O-1, I2-9, T-8, T-7 rows -> point at the live rules (Batch 1, 2026-09-03).
- docs/operator-state.md #31 (queue report): add the `EMPTY <iso>` outcome next to `LATE` / `NO-SUBSCRIBERS`.
- docs/operator-state.md #56: DONE in this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
