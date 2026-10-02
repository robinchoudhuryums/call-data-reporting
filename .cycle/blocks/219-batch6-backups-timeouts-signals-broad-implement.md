---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 6 -- "Backups, timeouts, engine signals"; dashboard + one cdr-report file):
- BU-1 the Neon backup FAILS (naming the id) when NEON_BACKUP_SS_ID is set but the workbook will not open -- it used to silently create a fresh empty workbook, resetting rotation and orphaning the old backups
- DL-3 every dashboard Neon statement carries a query timeout: getDashboardNeonConn_ returns a wrapper that sets setQueryTimeout (120 s default; the backup asks for 240 s) on every prepared/created statement -- a lock wait used to run to the execution ceiling, whose kill skips the sheet fallback
- CR-6 the same for cdr-report's shared reader factory getNeonConn() (the 9 AM Inbound / Outbound exports, the insurer sync, dbReporting): 240 s per statement
- BU-4 the weekly coaching delivery: every dept errored -> FAILED, nothing written, no email; some errored -> PARTIAL naming them, and their open rows are not closed (was `ok`)
- BU-3 the backup has a 5-minute run budget, writes the NEWEST months first, and records PARTIAL naming the months not reached (it used to be killed mid-run, recording nothing, oldest-first)
- EN-1 the four editor-run installers record who installed each trigger (TRIGGER_INSTALLERS); the Health row for a trigger another account installed reads warn and names them instead of "NO trigger installed"
- EN-6 the pipeline-failure watchdog re-reads 2 h before its watermark and alerts on unseen failure rows (PIPELINE_WATCH_SEEN), so a slow run's earlier-stamped failure is no longer skipped forever; unparseable failure rows are counted in the email
- AC-6 client-issue beacon emails are capped per signed-in user (5 per 6 h) as well as globally, so one user's broken tab cannot spend the whole window cap
- BU-2 a backup whose only problem is a warning records WARN (was `ok`), which Health shows amber and which holds the retention prune
- EN-8 alert recipients are validated; malformed addresses are skipped and named in the Alert Log note instead of failing the whole send
- EN-7 the low-answer-rate email names the denominator the configured ANSWER_RATE_FORMULA uses ("answered-or-missed calls" vs "rung calls")

Files modified:
apps-script/department-dashboard/NeonBackup.gs, apps-script/department-dashboard/NeonRead.gs, apps-script/department-dashboard/SystemHealth.gs, apps-script/department-dashboard/Coaching.gs, apps-script/department-dashboard/PipelineWatch.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/DqeSilenceWatch.gs, apps-script/department-dashboard/SheetCoverage.gs, apps-script/department-dashboard/NeonRetention.gs, apps-script/cdr-report/dbHistorical.js, tests/unit/neon-backup.test.js, tests/unit/system-health.test.js, tests/unit/coaching.test.js, tests/unit/pipeline-watch.test.js, tests/unit/alert-recipients.test.js, tests/unit/neon-conn-memo.test.js, tests/unit/cdr-report-neon-timeout.test.js (new), tests/README.md, CLAUDE.md (AC-6 cap in the beacon bullet), docs/operator-state.md (#8, #28, #32), docs/module-dependencies.md (regenerated)

CHANGES:
BU-1 | NeonBackup.gs (nbSheetsFolder_) | an id that will not open throws naming the id and the "clear it if deleted on purpose" step; never recreates
DL-3 | NeonRead.gs (NEON_QUERY_TIMEOUT_S_, neonTimedConn_, getDashboardNeonConn_ opts.queryTimeoutS), NeonBackup.gs (NB_QUERY_TIMEOUT_S_=240) | wrapper forwards the six Connection methods the dashboard uses; idempotent; a driver without setQueryTimeout is tolerated
CR-6 | cdr-report/dbHistorical.js (CDR_REPORT_QUERY_TIMEOUT_S_=240, cdrTimedConn_, getNeonConn) | same wrapper shape; getNeonConn_backfill / neonWrite writers untouched (INV-16 pair unchanged)
BU-4 | Coaching.gs (coachingDeliveryRun_) | all-errored early FAILED; errored depts' open rows excluded; PARTIAL / NOTIFY-FAILED / ok prefix
BU-3 | NeonBackup.gs (NB_RUN_BUDGET_MS_, overBudget, newest-first month loop, per-table partial text, config tables budget-checked) | PARTIAL outcome
EN-1 | Util.gs (recordTriggerInstaller_, readTriggerInstallers_), PipelineWatch.gs / DqeSilenceWatch.gs / SheetCoverage.gs / NeonRetention.gs (install + uninstall record), SystemHealth.gs (svc foreign-installer warn row), Config.gs (TRIGGER_INSTALLERS registered) | Health names the other account
EN-6 | PipelineWatch.gs (PIPELINE_WATCH_LOOKBACK_MS_, seen store read/write + prune, seed mode, pipelineWatchScan_ lookback/seen opts, unparseable count), Config.gs (PIPELINE_WATCH_SEEN registered) | seen store written on baseline / no-new / sent; not on a failed send
AC-6 | SystemHealth.gs (CLIENT_ISSUE_USER_CAP_, per-user md5 cache counter in reportClientIssue) | capped reports still Logger.logged
BU-2 | NeonBackup.gs (status ladder FAILED > PARTIAL > WARN > ok), SystemHealth.gs (HEALTH_BAD_PREFIXES_ gains WARN) | retention gate (/^ok\b/) holds on WARN and PARTIAL
EN-8 | Alerts.gs (ALERT_EMAIL_RE_, resolveRecipients_ invalidOut, invalidNote on sent / no-recipients notes) | bad addresses named, good ones still sent
EN-7 | Alerts.gs (email denominator text keyed on getAnswerRateFormula_()) | wording only

TEST RESULTS: passed -- `npm run ci` 2071/2071 (18 new tests incl. the new cdr-report-neon-timeout suite), INV-16 guard clean, module-deps regenerated + up to date; bare `TZ=UTC node --test` 2071/2071; `CI=true npm run lint:gas` clean (75 files); claude-md-split green. Every new pin was mutation-checked against the pre-batch file (git stash). Test doubles updated as part of the fixes: the O-9 bad-prefix list in system-health now includes WARN (and PARTIAL, already classified); the EN-8 run test builds a fixture that includes the 'Alert Log' sheet; the existing pipeline-watch tests needed no change (the seed mode keeps their first-run baseline behavior). Two mid-run failures were this session's own (BU-4 test called a SystemHealth helper the coaching suite does not load; EN-6's first cut would have re-emailed the backlog on the first post-deploy run -- fixed with seed mode). ci:ui not run -- no client file touched.
REGRESSION RISKS:
- DL-3 / CR-6: a legitimately slow statement (>120 s dashboard, >240 s backup / cdr-report) now throws instead of finishing. None measured anywhere near that; each caller already has a catch / fallback for a thrown read. The wrappers forward only six Connection methods -- a new caller using a seventh (e.g. getMetaData) fails its sweep test before it ships.
- BU-1: an install whose backup workbook was deleted on purpose now FAILS every run until NEON_BACKUP_SS_ID is cleared (intended -- the operator decides; Apps Script cannot tell deleted from no-access without the Drive scope). Retention (#57) holds meanwhile.
- BU-3: a backup that cannot finish in 5 minutes now records PARTIAL and holds retention until a run completes; older closed months are written on later runs.
- BU-2: a backup that used to read `ok` with a capacity warning now reads WARN and holds retention -- intended.
- BU-4: an errored dept's open coaching rows stay open (they close on the next clean run).
- EN-1: triggers installed BEFORE this deploy have no recorded installer, so they read as before (no foreign warn) until reinstalled.
- EN-6: the first run after deploy seeds the seen store silently; a failure row older than 2 h before the watermark is still never re-read (the window is bounded on purpose).
- AC-6: a sixth distinct error from one user inside 6 h is logged, not emailed.
- EN-8: an address the regex rejects but Gmail would accept (none known in the domain) would be skipped and named.
INVARIANTS AT RISK: INV-01 (no new public write path; TRIGGER_INSTALLERS / PIPELINE_WATCH_SEEN are editor-run / trigger-written Script Properties, registered); INV-16 (neonWrite.js not touched -- cdr-report's reader factory lives in dbHistorical.js, which is not duplicated; guard clean); INV-32 (Alerts callables keep assertAdmin_); the CLAUDE.md "never put connectTimeout on a Neon JDBC URL" rule (followed -- timeouts are per statement; the cross-file-pins sweep passes). None violated.
NET SCORE: 2 − 1 = 1 (production fixes this month: BU-1 -- the Sheets-fallback store shipped 2026-09-28 and recreates on any open failure; DL-3/CR-6 -- the hanging-statement class is documented as OPEN and recurring (#70). BU-2/BU-3/BU-4/EN-1/EN-6/EN-7/EN-8/AC-6 are real but with no evidence of firing this month. New failure mode, documented above: DL-3/CR-6 turn a very slow statement into a thrown error.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (every finding but CR-6) | BLOCKS DEPLOY: Y
- Deploy cdr-report (CR-6) | BLOCKS DEPLOY: N
- If the next backup outcome reads FAILED naming NEON_BACKUP_SS_ID: restore access to that workbook, or -- only if it was deleted on purpose -- clear the property and "Back up now" (Operator State #28) | BLOCKS DEPLOY: N
- Re-run the four editor installers you use (installPipelineWatchTrigger / installDqeSilenceWatchTrigger / installSheetCoverageTrigger / installNeonRetentionTrigger) from the deploying account so their installer is recorded; a Health warn naming another account means that person must uninstall first (Operator State #8) | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)
CDR Reporting Tools: `scripts/deploy.sh apps-script/cdr-report`

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- cdr-report's writer factories (neonbackfill.js getNeonConn_backfill, neonWrite.js getReachableNeonConn_ beyond its 5 s probe) and cdr-import's still carry no per-statement bound; neonWrite.js is an INV-16 pair, so that is a two-file change for its own batch.
- EN-1 covers only the four editor-run installers; triggers installed from modals (alerts, digests, backup, keep-warm) still read "NO trigger installed" when another admin installed them.
- The hanging CONNECT (as opposed to statement) remains unbounded -- the platform rejects connectTimeout (CLAUDE.md Neon rule 1).
DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (Operator State #8 / #28 / #32, the CLAUDE.md beacon bullet, tests/README). /sync-docs optional.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
