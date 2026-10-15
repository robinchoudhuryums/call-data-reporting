---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F42: the three CONFIG_SOURCE compare gates fail a duplicated key by name and report `compared` (they compared last-vs-last and printed PARITY CLEAN)
- F43: runOutboundVettingCheck returns INCONCLUSIVE when no called-back pair was sampled (it said "release is a one-line gate removal" having never verified the callback join)
- F15: the Neon backup keeps its Sheets store once that workbook holds the history (it silently created and switched to an empty Drive folder); a restore never creates a store
- F18: the DQE-silence watchdog reads a day with ZERO agent rows as INCONCLUSIVE, not every dept dark
- F19: the Alerts EMPTY outcome is judged over assessed depts, so a skipped config row can no longer hide it
- F46: auditQueueSplitAttribution's verdict names double-claimed queues instead of concluding "claimed by exactly one dept"
- F17: installIngestWatchdogTrigger / uninstall record the installer (EN-1), like the other four editor-run engines
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/Util.gs, DeptConfig.gs, Alerts.gs, Digest.gs, OutboundReport.gs, NeonBackup.gs, DqeSilenceWatch.gs, Diagnostics.gs, IngestWatchdog.gs
- docs/known-issues.md, docs/operator-state.md (#8 EN-1 text, #25, #28), docs/module-dependencies.md (regenerated)
- tests/unit/config-neon-c3.test.js, dept-config-neon.test.js, outbound-report.test.js, neon-backup.test.js, dqe-silence-watch.test.js, alerts-readiness.test.js, diagnostics-tools.test.js, system-health.test.js

CHANGES:
F42 | Util.gs, DeptConfig.gs, Alerts.gs, Digest.gs | new configSourceCompare_(label, sheetEntries, neonEntries): ordered [key, fingerprint] lists, first-seen fingerprint per key (the live readers' first-row-wins), a key repeated on either side -> clean:false + `duplicates`, `compared` = keys on both sides. The three gates feed it (Alert key case-folded like OPS-9's duplicate key); unreachable returns gained `compared: 0, duplicates: []`. Reachable empty-vs-empty stays clean (the existing pin; both stores serve the seed constants) -- known-issues corrected to say so.
F43 | OutboundReport.gs | after the per-sample re-verification (MISMATCH still wins), `calledBack.length === 0` returns INCONCLUSIVE naming the window and the HMAC_SECRET cross-project check; params kept for the re-run (INCONCLUSIVE is a HEALTH_BAD_PREFIXES_ entry).
F15 | NeonBackup.gs | nbStore_(opts): NEON_BACKUP_STORE=sheets -> Sheets; otherwise, folder id unset + NEON_BACKUP_SS_ID set -> Sheets (no Drive attempt); `NEON_BACKUP_STORE=drive` is the deliberate move. opts.noCreate throws "no backup store exists yet" instead of creating; restoreNeonBackupFile passes it.
F18 | DqeSilenceWatch.gs | dqeSilenceReadDay_ counts distinct NON-sentinel agents (INV-23 pattern); zero -> { inconclusive, reason: 'no DQE agent rows at all for <date> ...' }.
F19 | Alerts.gs | alertsOutcomeString_: EMPTY when every non-`skipped` result is no-data and at least one dept was assessed (wording unchanged, ENG-3 pin intact).
F46 | Diagnostics.gs | double-claimed queues collected while listing; a ">> DOUBLE-COUNTED: N queue(s) ..." verdict; the "exactly one dept" line only when nothing was dropped AND nothing was doubled.
F17 | IngestWatchdog.gs, Util.gs | recordTriggerInstaller_('runIngestWatchdog_', true/false) in the two installers; EN-1 comment + Operator State text say five; the EN-1 source pin lists it.

TEST RESULTS: passed -- TZ=America/Chicago node --test: 2443 tests, 2442 pass, 0 fail, 1 skipped (CH-4 snapshot writer, by design). +9 tests. 9/9 manual bites caught. lint:gas clean (75 files); INV-16 guard clean; module-deps regenerated (configSourceCompare_ / recordTriggerInstaller_ edges) and --check clean. ci:ui not run (no client change).
REGRESSION RISKS:
- F42: compareAlertConfigSources now keys depts case-insensitively (OPS-9's duplicate rule); names in its lists print lower-case, and a sheet/Neon pair differing ONLY in the dept name's case now compares as the same key.
- F15: an install that started on the Sheets fallback and later gained the Drive scope stays on Sheets until NEON_BACKUP_STORE=drive is set (documented, #28).
- F18: a genuinely company-wide DQE outage is now INCONCLUSIVE here rather than a silence alert -- the ingest watchdog / PipelineWatch (the :DQE failure row) remain the signal for a missing build.
INVARIANTS AT RISK: None -- INV-01 (no new public write), INV-32 (Alerts admin gates untouched), INV-23 (sentinel pattern reused, not changed), INV-44 (no step-name change).
NET SCORE: 0 production fixes (none confirmed to have fired this month: each needs a duplicated config row, the 6c vetting run, a Drive-scope change, a missing DQE day, a skipped alert row, a double-mapped queue or a second admin's install) − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- None required. If the backup should move from the Sheets workbook to Drive, set NEON_BACKUP_STORE=drive (Operator State #28) | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- ST3 (one compare-gate helper for EVERY parity tool) remains expansion scope; configSourceCompare_ covers only the three config gates.
- An existing test in dqe-silence-watch.test.js and neon-mirror-tail.test.js deletes/stubs real functions on the shared context without restoring them; new tests here load fresh contexts to work around it.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made here (known-issues "A compare gate must never print a false PARITY CLEAN", Operator State #8 EN-1 / #25 / #28, module-dependencies.md).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
