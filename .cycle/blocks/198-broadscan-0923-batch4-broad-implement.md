---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ENG-3: Daily alerts now wait for the day's DQE data (the digest's R31 gate). They defer with a one-shot retry until noon, record LATE past it and EMPTY when every dept had no data, and a run marker stops a retry from re-alerting.
- DATA-2: Missed, IR and the IR/Insights picker no longer cache a payload built after a failed Dept Config read.
- DATA-3: A failed CSR-transfer read and a failed Insights prior Queue-health read are no longer cached as "no rows" for 6 h.
- S2A-3: The agent app no longer caches an outage- or config-degraded payload; the me blob caches only 5 min while the journey join is unavailable.
- ENG-5: Digest and queue-report Health rows now show INTERRUPTED (a send started and never recorded) and STALE (silent past the cadence's allowance).
- ENG-6: A malformed EMAIL_BCC entry is dropped instead of failing every send; the Health page names it.
- DATA-7: The Overview's pipeline-freshness verdict is re-aged at serve time instead of frozen in the 6 h blob.
- ING-3: A skipped or failed bulk-archive CDR/QCD Neon mirror now logs a failure-only Pipeline Health row.
- CRT-6: A backfill resume pointer defers the nightly sort only for the sheet it indexes; a pointer over 3 days old is a STALE-POINTER failure.
- ENG-7: A coaching run whose email failed now leads NOTIFY-FAILED (bad on Health), not "ok".
- ENG-8: The manual subscriber blast refuses a PARTIAL compute and toasts no-subscribers / all-failed as errors instead of "Sent … to 0".
Files modified:
- apps-script/department-dashboard/Alerts.gs
- apps-script/department-dashboard/Config.gs
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/InsightsReport.gs
- apps-script/department-dashboard/MissedCallsReport.gs
- apps-script/department-dashboard/IndividualReport.gs
- apps-script/department-dashboard/Util.gs
- apps-script/department-dashboard/AgentHome.gs
- apps-script/department-dashboard/Digest.gs
- apps-script/department-dashboard/QueueReportEmail.gs
- apps-script/department-dashboard/SystemHealth.gs
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/department-dashboard/Coaching.gs
- apps-script/department-dashboard/script-11-qcd-boot.html
- apps-script/cdr-import/autoImport.js
- apps-script/cdr-report/sheetRepairs.js
- apps-script/cdr-report/neonbackfill.js
- tests/unit/alerts-readiness.test.js (new)
- tests/unit/missed-report.test.js
- tests/unit/individual-report.test.js
- tests/unit/compute-summary.test.js
- tests/unit/insights-report.test.js
- tests/unit/agent-home.test.js
- tests/unit/system-health.test.js
- tests/unit/app-email.test.js
- tests/unit/freshness-weekend.test.js
- tests/unit/csr-transfer.test.js
- tests/unit/historical-sort.test.js
- tests/unit/neon-backfill-resume.test.js
- tests/unit/coaching.test.js
- tests/unit/queue-report.test.js
- tests/README.md
- docs/fix-history.md
- docs/operator-state.md
- docs/invariants.md
- docs/module-dependencies.md
- CLAUDE.md

CHANGES:
ENG-3 | Alerts.gs, Config.gs, alerts-readiness.test.js | `runDailyAlerts_` → `alertsGatedAttempt_`:
  - It keeps the weekend and holiday skips, then applies the R31 gate (`digestLatestDqeIso_`, cutoff 12:00, retry 60 min).
  - If no retry trigger can be scheduled, it assesses immediately.
  - `ALERTS_RUN_MARKER` is registered in the prop registry.
  - `alertsOutcomeString_` sets the outcome's leading word, in priority order: FAILED-PARTIAL, then LATE, then EMPTY, then ok.
  - The uninstall clears a pending retry.
DATA-2 | MissedCallsReport.gs, IndividualReport.gs, Util.gs | Each cache put is guarded by `!deptConfigReadFailed_()`.
DATA-3 | Config.gs, Data.gs, InsightsReport.gs | New per-execution `noteBestEffortReadFailed_` / `bestEffortReadFailed_`. The CSR-transfer catch marks it; the summary sets `meta.sectionReadFailed` and skips the put. The Insights prior Queue-health catch marks the D-5 QCD flag.
S2A-3 | AgentHome.gs | `ahFetchDalRows_` marks `sourceUnavailable` when Neon is unusable and the sheet is empty. `agentHomeCacheable_` gates the team, me and history puts. The me blob's TTL drops to `CACHE_TTL_SECONDS` when the join is unavailable.
ENG-5 | Digest.gs, QueueReportEmail.gs, SystemHealth.gs, Config.gs | Outcome writes go through the new recorders `digestRecordResult_` and `queueReportRecordResult_`, which stamp `*_LAST`. Starts are stamped as `DIGEST_STARTED_<cadence>` and `QUEUE_REPORT_STARTED`. Outcome rows gain `atProp`, `maxAge` (4d / 9d / 35d / 4d) and an 8th `startedProp` column. The INTERRUPTED check fires when the started stamp is newer than `*_LAST` and older than 30 min. The O-14 test that pinned "QUEUE_REPORT_LAST is never written" was rewritten.
ENG-6 | Config.gs, SystemHealth.gs | `appEmailBccConfig_` validates entries (`APP_EMAIL_ADDR_RE_`). If no entry is valid, the default admin BCC applies. New `email-bcc` config row, shown only when something was dropped.
DATA-7 | CompanyOverview.gs | Extracted `ovFreshnessAt_`. `ovReageFreshness_` runs on the admin serve paths of `personalizeOverview_`, including the shallow-copy fallback, and returns a new object.
ING-3 | cdr-import/autoImport.js, SystemHealth.gs, invariants.md | `bulkArchiveMirrorGap_` is called on the skip and throw paths of both bulk mirrors. The QCD mirror result is now checked. Two new failure-only step names are in `HEALTH_FAILURE_ONLY_STEPS_` and INV-44.
CRT-6 | cdr-report/sheetRepairs.js, neonbackfill.js, SystemHealth.gs | Added `HISTORICAL_SORT_RESUME_SHEET_`, `hsPointerAgeDays_` and `HISTORICAL_SORT_STALE_POINTER_DAYS_`=3. `nbResumeWrite_` stamps `writtenAt` (`nbResumeRead_` ignores it). The Health `historical-sort` row names part-deferred runs. The old "defers the whole run" test was rewritten.
ENG-7 | Coaching.gs | A failed or no-recipient notification makes the result lead `NOTIFY-FAILED ` (the classifier already matches "fail").
ENG-8 | QueueReportEmail.gs, script-11-qcd-boot.html | `sendQcdAllDeptToSubscribers` throws on `partialReport` and returns `noRecipients` / `allFailed`. The client shows an error toast for each.

TEST RESULTS: passed.
- `node --test`: 1830/1830 (TZ=America/Chicago).
- INV-16 guard: clean. `module-deps --check`: clean (regenerated). `CI=1 npm run lint:gas`: clean.
- `npm run ci:ui`: all stages passed, since script-11 changed.
- New tests were bite-checked red against the pre-change files (SystemHealth ENG-5, CompanyOverview DATA-7, and the earlier DATA-2/3 and S2A-3 tests).
REGRESSION RISKS:
- ENG-3: on a late-import day, managers' low-answer-rate alerts now arrive when the data lands (up to noon), not at 8 AM on a zero-data read.
  - Each deferral uses one extra trigger slot for up to an hour.
  - At the 20-trigger quota the retry cannot be scheduled and the run assesses immediately (the old behaviour).
  - The marker means a manual `runDailyAlerts_` re-run from the editor on an already-assessed day is a no-op. The Alerts modal's "Send alerts" uses `runAlertsCore_` directly and is unaffected.
- DATA-2/3 and S2A-3: a degraded read now costs a recompute on the next request instead of a cached wrong answer. That is slightly more load during a Dept Config or Neon incident.
- ENG-5: a real send taking longer than 30 min cannot happen (6-min ceiling), so no false INTERRUPTED. Installs upgraded mid-flight have no `*_LAST` yet, and the STALE check needs `at`, so none fire until the first recorded run.
- CRT-6: a sort of QCD / CSR / Q Path can now run while a DQE pointer is set. That is correct, because the pointers index only their own sheet (verified per pointer in neonbackfill.js).
- ENG-7: the coaching modal's "Last run" line now shows NOTIFY-FAILED text. Nothing parses the prefix client-side.
INVARIANTS AT RISK: None.
- INV-01: no new public write. The ENG-8 flags come from an existing admin-gated RPC.
- INV-16: neither duplicated file was edited.
- INV-44: two failure-only names added to both the list and the doc; the test pins agreement.
- INV-39: the re-aged freshness stays admin-only; the strip still runs for managers.
- INV-30: no aggregation rule changed; the cache-skip gates change what is cached, not how it is keyed.
NET SCORE: 1 − 0 = 1.
- Production fix: ENG-3. Late imports are the documented reason R31 exists for digests, so alerts hit the same mornings.
- The rest are real but need an incident (a failed config read, a killed send, a typo, an outage, an abandoned pointer), so they were not counted.
- No new failure mode. The ENG-3 retry-trigger slot falls back to the old behaviour at quota.

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard. | BLOCKS DEPLOY: N
- Deploy cdr-import (ING-3) and cdr-report (CRT-6). | BLOCKS DEPLOY: N
- After deploy, open Health once:
  - the `email-bcc` row appears only if `EMAIL_BCC` holds a malformed entry;
  - `historical-sort` may now show a STALE-POINTER failure if an old backfill pointer was being ignored. Finish that backfill or delete the property (Operator State #61).
  | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Deploy → Manage deployments → New version (or `scripts/deploy.sh .`)
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The daily-path CDR/QCD mirror SKIP (unreachable, not throw) in `processIntegratedHistory` is still console-only. Only its throw gets an L7 row. ING-3 closed the bulk path only; same fix shape.
- Alerts has no INTERRUPTED signal. It records nothing until its per-dept loop finishes, but it already carries a 4-day STALE allowance.
- ENG-4 (Batch 8) is partly addressed by ENG-3's `ALERTS_RUN_MARKER`; re-scope it when Batch 8 runs.
- Remaining broad-scan batches 5–11 (`.cycle/blocks/195-broadscan-0923-plan.md`).

DOCUMENTATION UPDATES NEEDED:
- Done:
  - docs/fix-history.md (Batch 4 section)
  - docs/operator-state.md (#8 alerts readiness, #12 INTERRUPTED/STALE, #58 BCC validation, #61 per-sheet deferral)
  - docs/invariants.md INV-44
  - CLAUDE.md (sort-deferral sentence)
  - tests/README.md (alerts-readiness, app-email)
- None outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
