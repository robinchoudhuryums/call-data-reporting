---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (broad-scan 2026-10-01, Batch 2 -- "lock discipline and dashboard availability"):
- AC-1  a transient Dept Config read failure no longer locks Sales / CSR / Power managers out of My Department (and the dept email): the sub-queue set is filtered to depts the viewer can reach (new userCanAccessDept_), and the IR/Insights picker groups follow the viewer too
- EN-2  runAlertsCore_ no longer holds the project-wide script lock across every dept's compute + send; real-send de-duplication rides the ALERTS_RUN_CLAIM date claim (short lock) on BOTH callers
- AC-4  pinned: an escalation write (or any tryLock) succeeds while an alerts run is sending
- ESC-D2 escalation write verbs connect + check the schema BEFORE taking the script lock (escOpenWriteConn_ / escTakeWriteLock_), and every escalation statement carries setQueryTimeout(30) (escTimed_)
- AC-5  the escalation schema DDL (~11 statements incl. 5 ALTER TABLE) runs once per execution and once an hour across executions (escEnsureTableOnce_ + an escSchema:v1 cache flag keyed on ESC_REQUIRED_COLUMNS_), instead of on every list load and card expand; never cached after a failed column/activity DDL
- EN-4  a thrown digest run records `FAILED (threw): ...` in DIGEST_LAST_RESULT_<cadence> (Health no longer reads the stale "ok"), and the failure email no longer promises a retry that never happens
- EN-3  the Daily Call Queue Report poller emails a failure once per error signature per day instead of on every 30-minute poll
- EN-5  a manual "Send alerts" claims the date and advances ALERTS_RUN_MARKER (forward only) + records the outcome, so the 8 AM trigger does not re-send the same alerts

Files modified:
apps-script/department-dashboard/Util.gs, apps-script/department-dashboard/Data.gs, apps-script/department-dashboard/IndividualReport.gs, apps-script/department-dashboard/Alerts.gs, apps-script/department-dashboard/Escalations.gs, apps-script/department-dashboard/Digest.gs, apps-script/department-dashboard/QueueReportEmail.gs, apps-script/department-dashboard/Config.gs, apps-script/department-dashboard/Auth.gs (comment), tests/unit/subqueue-access.test.js, tests/unit/alerts-readiness.test.js, tests/unit/escalations-hardening.test.js, tests/unit/queue-report.test.js, tests/unit/digest-freshness-gate.test.js, tests/unit/cache-version-sync.test.js, docs/invariants.md (INV-55), docs/operator-state.md (#12d), docs/module-dependencies.md (regenerated)

CHANGES:
AC-1 | Util.gs (userCanAccessDept_, computeSubQueuePickerGroups_ gains `user`), Data.gs (getDepartmentSummary sub-queue filter), IndividualReport.gs (passes user) | unreachable children dropped (logged) instead of throwing; a degraded run computes subScope 'own' -> its own cache key, and the existing deptConfigReadFailed_ guard skips the put
EN-2 + AC-4 | Alerts.gs (runAlertsCore_ lock removed; sendAlerts claims; alertsClaimRun_ gains opts.manual), Digest.gs + Auth.gs comments | no lock held during sends; manual double-click refused by the claim; a deliberate sequential re-send still allowed
EN-5 | Alerts.gs (alertsAdvanceMarker_, sendAlerts records the outcome when it advanced the marker) | manual send marks the date; back-dated sends never move the marker back
ESC-D2 | Escalations.gs (escTimed_, escOpenWriteConn_, escTakeWriteLock_; the 14 write preambles rewritten; reads wrapped) | connect + schema outside the lock; a busy lock closes the opened conn; 30 s statement timeout
AC-5 | Escalations.gs (escEnsureTable_ returns {columnsOk, activityOk}; escEnsureTableOnce_; 16 call sites), cache-version-sync.test.js (escSchema registered as an exception prefix), Health esc-schema hint wording | memoized schema DDL
EN-4 | Digest.gs (digestGatedAttempt_ catch, notifyDigestFailure_ steps), operator-state.md #12(d) | FAILED (threw) recorded; honest re-run instruction
EN-3 | QueueReportEmail.gs (queueReportFailureIsNew_, QUEUE_REPORT_FAIL_NOTIFIED_PROP), Config.gs PROP_REGISTRY_ | once-per-signature-per-day failure email

TEST RESULTS: passed -- `npm run ci` 2003/2003 (10 new tests), INV-16 guard clean, module-deps regenerated + up to date; bare `TZ=UTC node --test` green; `CI=true npm run lint:gas` clean. Every new pin was confirmed to FAIL against the pre-batch file (git stash) and pass after. One mid-run failure was this session's own (cache-version-sync S2: the new escSchema prefix was unregistered) -- fixed by registering it. ci:ui not run -- no client file touched.
REGRESSION RISKS:
- AC-5: a cached schema flag can hide a DROPPED / freshly-restored escalations table for up to 1 h (writes then fail with "relation does not exist" until the flag expires); a failed column DDL is never cached.
- ESC-D2: an escalation statement slower than 30 s now fails instead of running on (none of the escalation queries should approach it); a schema-check failure now surfaces as "Escalations storage schema check failed" instead of the verb's own "Could not save ..." text.
- EN-2: alerts no longer serialize against OTHER admin writes (Orphan Fix / Dept Config / Alert Config saves) -- a config edit landing mid-run is read as of the run's start (readAlertConfig_ is read once); ALERTS_RUN_CLAIM is one property, so two runs for DIFFERENT dates at the same moment can overwrite / release each other's claim (pre-existing for the trigger path; manual sends now share it).
- EN-5: a manual send now changes what the 8 AM trigger does for that date (stands down) -- intended.
- AC-1: a degraded (config-read-failed) execution shows the parent's own view without its sub-queues rather than an error; the next request re-reads config.
INVARIANTS AT RISK: INV-01 / INV-55 (escalation write paths restructured -- gates and row checks unchanged, source sweep pins the new order); INV-32 (Alerts still admin-gated: sendAlerts keeps assertAdmin_ first); INV-38 (sub-queue access -- now strictly narrower in the degraded case, never wider); INV-30 (new escSchema prefix registered as a non-report exception). None violated.
NET SCORE: 1 − 2 = -1 (production fixes: AC-5 -- the DDL ran on every escalation read in production; AC-1 / EN-2 / ESC-D2 / EN-3 / EN-4 / EN-5 are real mechanisms with no evidence they fired this month. New failure modes, both documented above: the AC-5 flag can mask a dropped table for <=1 h; the shared ALERTS_RUN_CLAIM now also carries manual sends.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (every change is in the dashboard project) | BLOCKS DEPLOY: Y
- After deploy, walk S50-S53 (escalation move / link / remove / restore) once -- their write paths were restructured; the Health page's esc-schema row should read OK | BLOCKS DEPLOY: N
- After the next 8 AM run, the Health page's out-alerts / out-digest rows should read ok, with no SKIPPED-LOCK digest outcome | BLOCKS DEPLOY: N
Deploy:
Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- getEscalationsBadge and escPendingReviewPing_ still use an unwrapped connection (no statement timeout) -- left out of ESC-D2's scope (the badge already skips the DDL); the dashboard-wide timeout sweep is DL-3 (Batch 6).
- ALERTS_RUN_CLAIM is a single property keyed by date in its value; a per-date property would remove the different-date collision.
- The digest throw path could schedule one same-day retry (like the freshness defer) instead of asking for a manual re-run.
DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md: no bullet describes the alerts/escalation lock discipline; consider one line in Common Gotchas ("never hold the project-wide script lock across sends or a Neon connect -- escalations connect first, alerts claim the date") with its pins (alerts-readiness EN-2, escalations-hardening ESC-D2).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
