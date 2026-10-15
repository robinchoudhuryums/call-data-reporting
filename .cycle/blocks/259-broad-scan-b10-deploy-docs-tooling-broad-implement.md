---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F41 deploy.sh's "dirty tree" check is scoped to the project's clasp rootDir, not the whole repo
- F40 one-sided deploy of the INV-16 pair is detected (deploy-time warning + Health `inv16-skew` row)
- F38 lint:gas only allows an advanced-service global the project's manifest enables
- F39 the test harness resets EVERY *MEMO* global per h.call (a fresh execution); h.inExecution shares one
- F36 stale Outbound-modal / Insights-fold references in README + ui-harness docs + ci.mjs labels
- F37 small doc drifts (five JDBC builders, LA TZ = 3 failures, BuildStamp restore wording, THEME has no `bad`)
- F6 stale DEPT_QUEUE_EXT_OVERRIDES / getDeptQueueExts_ purpose comments, the snapshot "all-queues sum" comment, two dead `numCols`
- F14 dataFilters.js "CDR Pipeline v31" comment
- F53 dead `ovWireTablePeriodBar_` (its bar markup no longer exists) + its call
NOT implemented: F35 (INV-17 premise) -- BLOCKED on an operator check that needs authenticated clasp (see OPERATOR ACTIONS).
New capabilities (G/ST): None
Files modified: CLAUDE.md, README.md, apps-script/cdr-report/dataFilters.js, apps-script/department-dashboard/{Alerts.gs, BuildStamp.gs, Config.gs, Data.gs, IndividualReport.gs, InsightsReport.gs, SystemHealth.gs, script-3-overview.html}, docs/{client-ui-conventions.md, module-dependencies.md, neon-layer.md, operator-state.md}, scripts/{deploy.sh, lint-gas.mjs}, tests/README.md, tests/harness/loadGas.js, tests/unit/{answer-rate-formula, client-lifecycle, cross-file-pins, dal-cutover, data-parsing, deploy-tooling, dqe-span-readers, neon-conn-memo, qcd-report, system-health, util, workbook-memo}.test.js, tests/unit/snapshots/ch4-payloads.json, tools/ui-harness/{README.md, ci.mjs}

CHANGES:
F41 | scripts/deploy.sh, tests/unit/deploy-tooling.test.js | PUSH_SCOPE resolved from the project's .clasp.json rootDir (fallback: the project dir); TREE_DIRTY + the dirty warning use `git status -- "$PUSH_SCOPE"`, so an unrelated docs edit no longer marks a push dirty; DEP-3 pins updated, new F41 test runs the block for all three projects
F40 | scripts/deploy.sh, SystemHealth.gs, docs/operator-state.md #2, tests/unit/system-health.test.js, ch4 golden | inv16_hash_ (8-hex sha256 of the pair); sibling stamps carry `| <project> inv16 <hash>`; a pre-push warning when the other sibling's last deploy (from this checkout) shipped a different pair; Health row `inv16-skew` (newest hash per project from Pipeline Health: muted until both report, warn when they differ)
F38 | scripts/lint-gas.mjs, tests/unit/cross-file-pins.test.js | Drive/Docs/Sheets/Gmail/BigQuery/People/Blob/Ui removed from the static allowlist; each project's globals add its appsscript.json enabledAdvancedServices userSymbols; test runs the real linter on a temp copy (Drive undefined until enabled, Blob always)
F39 | tests/harness/loadGas.js, Alerts.gs (let->var ALERT_DATE_ROWS_MEMO_), 9 suites, tests/README.md, CLAUDE.md | every ctx `*MEMO*` (not *_MAX_/*_CAP_) is snapshotted at load and restored before each top-level h.call/h.fn; h.inExecution(body) shares one execution; suites that modelled one execution across several calls now say so (two formerly-vacuous seeding tests now seed inside it)
F36 | README.md, docs/client-ui-conventions.md, tools/ui-harness/README.md, tools/ui-harness/ci.mjs | Reports menu = Individual + Agent day (+ admin Inbound/Direct); Outbound modal retired (G3); Outbound summary + Callbacks sit under the outbound table (UX-1)
F37 | CLAUDE.md, docs/neon-layer.md, tests/README.md, BuildStamp.gs | "six builders" -> five (the pin's list); LA TZ re-measured = 3 failures; placeholder restored from a pre-write copy (DEP-2), not git; OKLCH token list drops `bad`
F6 | Config.gs, Data.gs, InsightsReport.gs, IndividualReport.gs | ext-override comments say floater matching (sentinels are by queue NAME since R6/R8-1); snapshot totals documented as OWN-queues (P3, allTotals for all); unused `numCols` removed (both)
F14 | apps-script/cdr-report/dataFilters.js | inner "CDR Pipeline v31" comment now points at cdr-import/autoImport.js (INV-16 guard still clean)
F53 | script-3-overview.html, tests/unit/client-lifecycle.test.js | ovWireTablePeriodBar_ + ovTablePeriodWired deleted (no #ov-user-table-period in the markup -- it returned at line 1); call removed; the card bar's R12-19 shared window is unchanged; test stub dropped

TEST RESULTS: passed -- 2494 tests, 2493 pass, 0 fail (TZ=America/Chicago); lint:gas clean (75 files); INV-16 guard clean; module-deps regenerated (--check clean); ci:ui all stages passed. Bites 7/7 on the behavioural pins (DEP-3 + F41 scope, F40 row, F40 hash x2, F38, F39); a mutation of deploy.sh's empty-hash guard is NOT caught (harmless -- the Health regex needs 8 hex); F53/F6/F14/F36/F37 are deletions/comments with no pin by design (F53 covered by ci:ui rendering green). TZ=America/Los_Angeles: 3 failures, all pre-existing fixture-TZ (P-12, INV-21, I2-9).
REGRESSION RISKS:
- F39: a suite that relied on a memo surviving across h.calls without saying so now re-reads; all such suites found by the full run were wrapped in h.inExecution. New suites must do the same (tests/README rule 3).
- F41: a .clasp.json with an unusual rootDir resolves through node's path.resolve; a parse failure falls back to the project dir, which is still narrower than the old repo-wide check.
- F38: a future advanced service used without enabling it in the manifest now FAILS lint (intended).
INVARIANTS AT RISK: None (INV-16 pair untouched; INV-17 docs unchanged pending F35; CH-4 golden changed only by the new inv16-skew row).
NET SCORE: 1 − 0 = 1 (F41 YES: any uncommitted docs edit marked a dashboard push "dirty"; F40/F38/F39/F36/F37/F6/F14/F53 NO)

OPERATOR ACTIONS / DEPLOY:
- F35 operator check (unblocks F35): in a scratch copy of one project, add a throwaway .gs, `clasp push -f`, delete it locally, `clasp push -f` again, then run `node scripts/check-remote-orphans.mjs <dir>` and look in the web editor -- does the file survive the second push? Report the result; the INV-17 / CLAUDE.md gotcha / Operator State #29 / deploy.sh / check-remote-orphans text is rewritten from it | BLOCKS DEPLOY: N
- Use scripts/deploy.sh for BOTH cdr-import and cdr-report going forward so each reports its inv16 hash; the Health row stays muted until both have deployed and run once | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root (or scripts/deploy.sh .), then Deploy → Manage deployments → New version
- CDR Reporting Tools (dataFilters.js comment only): `cd apps-script/cdr-report && clasp push -f` -- optional, comment-only
- CDR Import: no change

FOLLOW-ON ITEMS:
- deploy.sh's empty-hash guard (`[ -f ... ] && printf`) has no biting pin; a missing pair would emit an empty token the Health row already ignores -- leave or pin.
- OV_TABLE_PERIOD_KEY_ ('cdr.ov.tableperiod.v1') is now read-only (a fallback for ovTablePeriod's initial value); it could join sweepOrphanPrefs_ once the shared window key has been live long enough.
- F62 PC-1 retroactive rewrite stays deferred (owner ruling).

DOCUMENTATION UPDATES NEEDED:
- After the F35 check: INV-17 (docs/invariants.md), the CLAUDE.md `clasp push -f` gotcha, Operator State #29, deploy.sh:182-191 and check-remote-orphans.mjs header.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
