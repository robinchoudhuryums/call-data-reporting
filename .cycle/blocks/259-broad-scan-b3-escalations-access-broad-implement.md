---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F44: escalation server-stamped times (created/resolved/removed, activity `at`) render as script-zone wall clock, and "overdue" uses the script zone's date -- the UTC Neon session showed them 5-6 h ahead and rolled overdue over at ~7 PM Central
- F45: the outage snapshot computes Overdue from its open rows and ships Resolved·MTD as unknown (a dash), never a false 0
- F1: a brand-new agent row saved while AGENT_ROLE_ENABLED is off gets no "Live now" welcome email; the response and the modal say it is staged
- F3: the coaching close verb connects to Neon and runs its DDL BEFORE taking the project-wide script lock, and bounds its UPDATE
- F2: logReportUsage_ passes the report and dept columns through sheetSafeCell_ (formula guard) at the one chokepoint
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/Escalations.gs, script-10-escalations.html, Auth.gs, script-7-admin.html, Coaching.gs, Util.gs
- docs/invariants.md (INV-55), docs/regression-scenarios.md (S40), docs/operator-state.md (#46), docs/module-dependencies.md (regenerated)
- tests/unit/escalations-hardening.test.js, escalations-snapshot.test.js, agent-role.test.js, coaching.test.js, report-usage.test.js

CHANGES:
F44 | Escalations.gs | ESC_OVERDUE_SQL_ (CURRENT_DATE) replaced by escOverdueSql_(): `(DATE '<script-zone today>' - occurred_at::date) >= 3`, used by the band aggregate and the badge. New escLocalTsSql_(col) = `to_char(col AT TIME ZONE '<script tz>', 'YYYY-MM-DD HH24:MI:SS.US')` (tz validated) for created_at / resolved_at / removed_at and the activity `at` in the list, the snapshot, the snapshot threads and both live thread queries. occurred_at deliberately stays ::text (a typed wall clock that round-trips through the session zone). Pins updated (ESC-L2 removed_at pattern); INV-55 + S40 text updated.
F45 | Escalations.gs, script-10-escalations.html | escSnapshotServe_ counts open (pending/in_progress) rows whose occurred_at date is >= ESC_OVERDUE_DAYS before the script-zone today; resolvedMTD: null. escRenderSummaryBand_ renders a muted dash for a null MTD (the live path always sends a number).
F1 | Auth.gs, script-7-admin.html | saveAccessControlRow: welcomeDeferred = brand-new row && role agent && !agentRoleEnabled_(); no acSendWelcomeEmail_ then; the response carries welcomeDeferred and the Add-agent status line says the row is staged (instead of "takes effect within ~60 s").
F3 | Coaching.gs | updateCoachingFlagStatus: getDashboardNeonConn_ + coachingEnsureTable_ before LockService.tryLock; a busy lock closes the connection and throws; UPDATE gets setQueryTimeout(30) (guarded); lock released only if held.
F2 | Util.gs | logReportUsage_: sheetSafeCell_ on the report + dept columns.

TEST RESULTS: passed -- TZ=America/Chicago node --test: 2449 tests, 2448 pass, 0 fail, 1 skipped (CH-4 snapshot writer, by design). +6 tests. 7/7 manual bites caught. lint:gas clean; INV-16 guard clean; module-deps regenerated + --check clean. npm run ci:ui (playwright 1.62.1, /opt/pw-browsers chromium): all stages passed.
REGRESSION RISKS:
- F44: the three timestamps + activity `at` change format from "...+00" UTC text to local "YYYY-MM-DD HH24:MI:SS.US" (escFmtWhen_ reads the prefix, so display only). Activity ORDER BY t.at now sorts local wall-clock text: inside the one repeated fall-back hour a year two entries can swap. A stored outage snapshot keeps old-format rows until its next refresh (minutes).
- F44 assumes nothing; it is correct whatever the Neon session zone is. Resolved·MTD's month boundary (date_trunc on now()) is still session-zone (follow-on).
- F1: staged agents are never welcomed automatically -- G3 (bulk welcome on flag flip) is expansion scope; #46 tells the operator to tell the pilot agents.
- F2: values beginning = + - @ now land with a text-prefix apostrophe (Sheets strips it from the value; the fake keeps it).
INVARIANTS AT RISK: None -- INV-55 (gates/transactions untouched; overdue definition still single, now escOverdueSql_), INV-01 (no new write path; Report Usage carve-out unchanged in shape), INV-36/INV-30 n/a.
NET SCORE: 1 production fix (F44 -- fires daily if the Neon session is UTC, Neon's default; confirm with `SHOW TimeZone`) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- Optional confirmation: run `SHOW TimeZone;` in the Neon console -- UTC/GMT means F44 was live; the fix is correct either way | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Escalations Resolved·MTD uses `date_trunc('month', now())` in the session zone (UTC): the month boundary is ~6 h early.
- Coaching.gs selects created_at / updated_at / closed_at as ::text too (the same UTC-render class) -- not in this batch.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made here.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
