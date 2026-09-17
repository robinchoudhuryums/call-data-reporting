---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: (broad-scan 2026-09-17, Batch 2 -- all 11)
- O-1 | CacheWarm recorded `ok (0 warmed, N failed)`; now FAILED-ALL when it warmed nothing and something failed (partial failures stay ok).
- OD-1 | NeonCoverage counted a missing sheet as a silent skip inside "ok clean"; now a probe error -> FAILED-PROBE.
- OD-2 | Health `retention-risk` rendered ok on a probe error ("every surviving date is mirrored (inbound_calls: <error>)"); now warn "could not check N table(s)".
- O-4 | IngestWatchdog + PipelineWatch swallowed their own throw (Logger-only); both now record `FAILED (threw …)` with a fresh *_LAST stamp; PipelineWatch leaves the watermark untouched.
- O-9 | The OPS-8 outcome classifier is ONE table-driven function (`healthOutcomeIsBad_` + `HEALTH_BAD_PREFIXES_`) with `stale` (the ingest watchdog's own verdict read green), UNPARSEABLE and SKIPPED-LOCK added; a company holiday inside a daily engine's gap extends its STALE allowance by one day (`healthHolidayCreditMs_`).
- O-5 | Outcome rows for the two REQUIRED engines: `out-alerts` (new ALERTS_LAST / ALERTS_LAST_RESULT written by runDailyAlerts_, ok / FAILED-PARTIAL / FAILED (threw)) and `out-digest-daily|weekly|monthly` (DIGEST_LAST_RESULT_<cadence>); the digest lock-contention skip records SKIPPED-LOCK.
- OD-7 | PipelineWatch counts failure rows whose Timestamp is unparseable and leads the outcome with `UNPARSEABLE n …` instead of "ok (no new failures)".
- O-8 | DQE-silence streaks carry `lastIso`; re-assessing the same date carries the streak forward unchanged (no double-count, no one-day alert). Pre-O-8 streaks (no lastIso) still grow.
- O-11 | The client-issue beacon announces a reached cap ONCE per 6 h window (cache marker `cissue:capat`, shares the count's TTL) and the Health page gains a `client-beacon` row (usage section) that warns while the cap marker stands.
- O-3 | The three "a trigger has no Session user" comments (Digest.gs, QCDReport.gs, Coaching.gs) corrected; the rule is written once at Util.gs::assertAdmin_.
- O-10 | LOGIN_NOTIFY_ENABLED read is case-insensitive.
Files modified: apps-script/department-dashboard/{CacheWarm,IngestWatchdog,PipelineWatch,NeonCoverage,SystemHealth,Alerts,Digest,DqeSilenceWatch,Auth,Util,QCDReport,Coaching,Config}.gs; tests/unit/{system-health,cache-warm-budget,ingest-watchdog,pipeline-watch,neon-coverage,dqe-silence-watch,alert-recipients,digest-freshness-gate,login-notify,queue-report}.test.js

CHANGES:
O-1 | CacheWarm.gs:199-206 | `warmPrefix = (warmed===0 && failed>0) ? 'FAILED-ALL' : 'ok'`
OD-1 | NeonCoverage.gs:121-131 | missing sheet -> `out.errors.push(...)` (summary already leads FAILED-PROBE on errors)
OD-2 | SystemHealth.gs retention-risk block | `probeErrors[]` split from `notes`; no atRisk + probeErrors -> warn with hint; atRisk hint carries "Could not check: …"
O-4 | IngestWatchdog.gs outer catch, PipelineWatch.gs outer catch | record `*_LAST` + `*_LAST_RESULT = 'FAILED (threw …): msg'`
O-9 | SystemHealth.gs (new `HEALTH_BAD_PREFIXES_`, `healthOutcomeIsBad_`, `healthHolidayCreditMs_`; the outcome loop) | inline regex replaced; `maxAge += holiday credit`
O-5 | Alerts.gs (new `alertsOutcomeString_`, `recordAlertsOutcome_`; runDailyAlerts_ records on success + throw), Config.gs PROP_REGISTRY_ (ALERTS_LAST, ALERTS_LAST_RESULT = engine), Digest.gs lock-skip, SystemHealth.gs outcomes table (+4 rows)
OD-7 | PipelineWatch.gs pipelineWatchScan_ (`unparseableFailures`), the no-new-failures record
O-8 | DqeSilenceWatch.gs dqeSilenceAssess_ | `lastIso` per streak; same-date carry-forward
O-11 | SystemHealth.gs reportClientIssue (cap note once per window) + `client-beacon` Health row
O-3 | Digest.gs:507-513, QCDReport.gs:296-306, Coaching.gs:141-146 comments; Util.gs assertAdmin_ docblock
O-10 | Auth.gs:757 `.toLowerCase() === 'false'`
Tests | 15 new tests + 3 existing tests updated to the new contract (silence day-1 shape + day-3 date; the R19 cap test now expects exactly one cap-reached note; queue-report's EMPTY source pin re-pointed at HEALTH_BAD_PREFIXES_).

TEST RESULTS: passed -- `node --test` 1591/1591 (15 new), `scripts/check-duplicated-files.sh` clean, `npm run lint:gas` clean (72 files). Bite-checks: O-1, O-9, OD-2, O-8, O-4 pins all BITE. `npm run ci:ui` NOT run (playwright absent here; the only client-visible change is one new Health row + four new outcome rows rendered by the existing generic row renderer).
REGRESSION RISKS:
- O-9: `healthOutcomeIsBad_` is a strict superset of the old inline regex (every old arm kept; three prefixes added). Any engine whose ok outcome BEGINS with "stale" would now read amber -- none does (grep: only IngestWatchdog writes it, and it IS a not-ok state).
- O-9 holiday credit: only ever WIDENS an allowance (never narrows); depends on `isCompanyHoliday_` (typeof-guarded).
- O-5: four new Health rows read properties that may not exist yet -> "never run" (muted) until the engines record once; `ALERTS_LAST(_RESULT)` are registered, so the props inventory does not flag them.
- O-11: ONE extra admin email per 6 h window when the cap is hit (intended; the R19 test was updated to expect it). The report that hits the cap is still not emailed.
- O-8: streak objects gain a field; the JSON is engine-written state (not an Operator State item); old streaks without `lastIso` behave exactly as before on their next assessment (pinned).
- OD-7: a Pipeline Health sheet with a non-Date Timestamp cell on a FAILURE row now reads amber every run until fixed -- that is the intent.
- O-4 (PipelineWatch): on a throw the watermark is NOT advanced, so the next run re-examines the same rows (correct; nothing was examined).
INVARIANTS AT RISK: INV-44 untouched (no step names changed); INV-01 untouched (no new public function -- alertsOutcomeString_/recordAlertsOutcome_ are `_`); INV-32 untouched; the PROP_REGISTRY_ rule honoured (prop-registry.test.js green).
NET SCORE: 4 − 0 = 4
  (a) fired this month: O-1 NO (needs an all-failed warm; not observed); OD-1 NO; OD-2 YES/likely (cold-compute timeouts on the Health page are the documented R21 shape); O-4 NO (needs a pre-record throw); O-9 YES (every stale ingest episode rendered its own row green; the Fri->Tue allowance edge after Labor Day, Sep 7, was a live Monday-holiday case); O-5 YES (no Health row for alerts/digests every day); OD-7 NO; O-8 NO (needs a same-day re-run); O-11 NO (cap not known to have been hit); O-3 doc; O-10 NO.
  (b) new failure modes: none identified.

OPERATOR ACTIONS / DEPLOY:
- None required. The four new outcome rows populate on the engines' next run (alerts: next weekday morning; digests: next cadence run). | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>` (run where playwright is installed so the ci:ui gate executes), or `clasp push -f` + Manage deployments -> New version.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The other did-nothing-reads-ok shapes the scan named are closed; the classifier contract now lives in one place -- any engine adding a not-ok state must add its prefix to HEALTH_BAD_PREFIXES_ AND the O-9 table test (system-health.test.js).
- Alerts' per-run outcome is written only by the TRIGGER path (runDailyAlerts_); manual sends from the modal still leave no *_LAST_RESULT (they are logged in the Alert Log). Fine by design; noted.
- Batches 3-9 of the scan plan remain; DD-2 awaits the owner's formula decision (block 101).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md "System Health … single trustworthy pipeline signal" bullet: one line that the outcome classifier is `healthOutcomeIsBad_` / `HEALTH_BAD_PREFIXES_` (the prefix contract), and that alerts + digests now have outcome rows. (Deferred here: the file is 4% under its size cap, T-6.)
- docs/operator-state.md #23 (ingest watchdog) and #32 (pipeline watch): a thrown run now records `FAILED (threw …)` on the Health page. #45: the flag is case-insensitive. #8/#12: the Health page's `out-alerts` / `out-digest-*` rows are the first place to look.
- docs/invariants.md INV-44 is unaffected; the OPS-8 prefix contract could be cross-referenced from INV-44's "Pipeline Health rows" entry.
- docs/fix-history.md: entries for O-1, O-4, O-5, O-8, O-9, OD-1, OD-2, OD-7, O-11.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
