---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- ENG-3: `PIPELINE_WATCH_SEEN` is capped in UTF-8 bytes (8000; oldest keys go first), the LOGIN_NOTIFY_SEEN rule. A 200-row burst no longer fails the write and gets re-emailed.
- ENG-4: the queue report writes `QUEUE_REPORT_LAST_SENT` BEFORE releasing its send claim, on both the poll and the manual blast.
- ENG-5: the client-issue beacon's 6 h window is FIXED: stamped at its first email, with counters expiring when the window does. The per-user key carries the window start.
- ENG-6: a digest cadence with no subscribers records an informational `IDLE` outcome, which the Health page renders muted, not amber. The queue report keeps `NO-SUBSCRIBERS` (O-9).
- ENG-7: a failed Alert Log append never aborts the alerts run. The unlogged rows are named, the outcome leads `FAILED-LOG`, and admins get one do-not-re-send email that lists the depts already emailed. An error that still escapes names those depts in the failure email.
- ENG-9: the smoke check's latest-date step removes the 5-minute cached value first, so it exercises the real read.
- ENG-14: `diagnoseAbandoned` attributes sentinel rows by queue NAME, through the report's own helper (`missedSentinelQueueNameSet_`), and says the abandoned counts are scope-independent.
Files modified:
- apps-script/department-dashboard/PipelineWatch.gs
- apps-script/department-dashboard/QueueReportEmail.gs
- apps-script/department-dashboard/SystemHealth.gs
- apps-script/department-dashboard/Digest.gs
- apps-script/department-dashboard/Alerts.gs
- apps-script/department-dashboard/SmokeCheck.gs
- apps-script/department-dashboard/Data.gs
- apps-script/department-dashboard/Diagnostics.gs
- apps-script/department-dashboard/MissedCallsReport.gs
- tests/unit/pipeline-watch.test.js
- tests/unit/queue-report.test.js
- tests/unit/system-health.test.js
- tests/unit/digest-wow.test.js
- tests/unit/alerts-readiness.test.js
- tests/unit/smoke-check.test.js
- tests/unit/diagnostics-tools.test.js
- CLAUDE.md
- docs/invariants.md
- docs/next-steps.md
- docs/module-dependencies.md

CHANGES:
ENG-3 | PipelineWatch.gs | New `PIPELINE_WATCH_SEEN_MAX_BYTES_` = 8000. `pipelineWatchSeenWrite_` drops the oldest keys (from the tail of the newest-first list) until the JSON fits.
ENG-4 | QueueReportEmail.gs | The poll writes the marker inside the send's try, before the `finally` releases the claim. It uses the O-1 rule: at least one delivery or a clean run; never a no-subscriber, partial, empty or all-failed run. The manual blast does the same for the previous business day.
ENG-5 | SystemHealth.gs | New `clientIssueWindow_` stamps `cissue:start` and resets the count and cap marker once a window has elapsed. Every counter and cap put uses the window's REMAINING TTL. The per-user key is suffixed with the window start. The doc comments now say "fixed".
ENG-6 | Digest.gs, SystemHealth.gs | `IDLE <iso>: no active <cadence> subscriber rows matched` replaces `NO-SUBSCRIBERS` for digests. The outcome row renders `muted` for a non-bad `IDLE`.
ENG-7 | Alerts.gs |
  - `pushAndLog` catches an append failure: it records it, appends a note to that row, and logs it.
  - `results.logFailures` and `results.sentDepts` are attached to the results.
  - An escaping error carries `alertsSent`.
  - `alertsOutcomeString_` leads `FAILED-LOG` when rows went unlogged.
  - New `alertsNotifyLogFailures_` (one email, from the trigger path).
  - The trigger failure email names the depts already emailed.
ENG-9 | SmokeCheck.gs, Data.gs | New `latestDateCacheKey_()` (one place, used by `getLatestDataDate`). The smoke step removes that key before reading.
ENG-14 | MissedCallsReport.gs, Diagnostics.gs |
  - New `missedSentinelQueueNameSet_(dept)`, extracted from the report (R6 / R8-1, unchanged behaviour).
  - `diagnoseAbandoned` matches sentinels by NAME through it, logs the name set and the scope, keeps the extension overlap as context only, and returns its tallies.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 2375 tests, 2374 pass, 0 fail, 1 skipped.
- INV-16 guard: in sync.
- module-deps: regenerated, `--check` up to date.
- `lint:gas` (CI=true): clean across 76 files in 3 projects.
- ci:ui: not run. No client file changed and the CH-4 payload goldens are unchanged.
- 9 bite checks, all BITE:
  - ENG-3: 1
  - ENG-4: 1
  - ENG-5: 2
  - ENG-6: 1
  - ENG-7: 2
  - ENG-9: 1
  - ENG-14: 1
- Old pins updated to the new behaviour:
  - the R19 beacon cap test now seeds a window start;
  - the P6 digest test now expects `IDLE`.

REGRESSION RISKS:
- ENG-5: a window that elapses while its keys survive is reset on the next report. At the deploy, any live counter without a start key begins a fresh window (one-time).
- ENG-6: an admin who armed digests but forgot to subscribe now sees a muted row instead of amber. That is the owner's intent for digests; the queue report keeps the amber O-9 signal.
- ENG-7: a run with unlogged rows records `FAILED-LOG` (amber), even though every send stands.
- ENG-9: the smoke check costs one real latest-date read per run.

INVARIANTS AT RISK: None.
- INV-01: no new write; Script Properties and CacheService only.
- INV-34: the Alert Log is still appended for every outcome, and an append failure is now surfaced rather than fatal.
- INV-45: the digest marker semantics are unchanged; only the outcome text differs.
- R6 / R8-1: the report's sentinel set is extracted verbatim.

NET SCORE: 1 − 0 = 1. ENG-6 is the one likely to have fired this month: a cadence with no subscribers kept its Health row amber. The rest are races, bursts or tool-only paths.

OPERATOR ACTIONS / DEPLOY:
- None. | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy → Manage deployments → New version).
- Other projects: not touched.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- ENG-7: `results.logFailures` does not reach the Alerts modal as a field; Apps Script serializes arrays without their extra properties. The per-row notes carry it instead.
- ENG-14: `diagnoseAbandoned` still reads the sheet directly (it is on the `DQE_SHEET_ONLY_ALLOWED` list, by design). On a Neon-only install with a trimmed sheet it reports nothing.

DOCUMENTATION UPDATES NEEDED:
- None remaining. Done in this commit:
  - the CLAUDE.md beacon bullet ("fixed 6 h window");
  - INV-45 (IDLE) and INV-34 (ENG-7);
  - the docs/next-steps.md Batch 6 row → IMPLEMENTED (block 252).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
