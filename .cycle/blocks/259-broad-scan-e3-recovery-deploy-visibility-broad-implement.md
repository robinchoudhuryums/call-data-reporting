---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E3 is an expansion batch -- new capability only)
New capabilities (G/ST):
- G1 "make date D whole": CDR Tools -> Make a date whole… (cdr-import) reads a per-date ledger -- the Call_Legs tab, the date's rows in the six history sheets, its row count in the six Neon tables -- runs only what is owed through the existing paths (a NON-force import for missing core sheets; the PIPE-7 per-call and F7 Direct/mirror catch-ups), reports the ledger before and after, and un-parks + remembers a date that ends whole
- G4 deploy currency across all three projects: every deploy.sh stamp carries `trees d=.. i=.. r=..` (each project's pushed-code hash as the checkout held it); the Health page's `deploy-currency` row takes the newest deploy as the stand-in for HEAD and warns for any project whose own deployed hash differs
Files modified: apps-script/cdr-import/{autoImport.js, CDR Tools.js}, apps-script/department-dashboard/SystemHealth.gs, scripts/deploy.sh, tests/unit/{pending-imports, system-health, cdr-tools-menus}.test.js, tests/unit/snapshots/ch4-payloads.json, tests/README.md, docs/{operator-state.md, module-dependencies.md}, .cycle/STATE.md

CHANGES:
G1 | apps-script/cdr-import/autoImport.js | processNewImport gains the opt-in `opts.ignoreLastSheets` (shouldRun = force || ignoreLastSheets || not remembered) -- nothing else in the import changes; new dateWholeLedger_ (sheets via checkHistoryForDate on the same date columns processNewImport uses; Neon via one probed connection and a 30 s-bounded count per table, null for a table it cannot count, a note when unconfigured/unreachable), PURE dateWholeOwed_ (missing sheets; Neon zeros only where the sheet holds the date; per-call zeros read "or a quiet day" until the backfill ran clean; deferred mirror mode owes nothing for the queued tables), PURE dateWholeReport_, makeDateWhole_ (the action, caller holds the lock) and the menu entry makeDateWhole (prompt, script lock, alert with the report). Never forces, so it can never delete rows.
G1 | apps-script/cdr-import/CDR Tools.js, tests/unit/cdr-tools-menus.test.js | "Make a date whole…" sits beside Manual Export at the top level; the top-level count pin 1 -> 2 with that reason.
G4 | scripts/deploy.sh | project_tree_hash_ (8-hex sha256 over a flat project folder's .gs/.js/.html/appsscript.json, name + bytes, sorted, EXCLUDING the stamp file); every stamp appends `| trees d=<h> i=<h> r=<h>`.
G4 | apps-script/department-dashboard/SystemHealth.gs, ch4 golden | PURE healthParseDeployStamp_ / healthDeployStamps_ (dashboard from BUILD_STAMP_, siblings from the newest Pipeline Health note naming them via the F40 `<project> inv16` token) / healthDeployCurrency_; the `deploy-currency` row (muted until all three report; ok; warn naming the projects behind). Golden diff = the new row only.
Docs | operator-state.md #2 + #56, tests/README.md | how to read deploy-currency; #56 now starts with Make a date whole for a MISSING-something date (Manual Export stays the tool for WRONG rows).

TEST RESULTS: passed -- 2518 tests, 0 fail (TZ=America/Chicago); lint:gas clean; INV-16 guard clean (no duplicated file touched); module-deps regenerated (--check clean); claude-md-split clean. Bites 12/12 (G4: verdict, newest-as-reference, newest-row-per-project, stamp-file exclusion, the stamp token; G1: ignoreLastSheets, never-force, un-park, the per-call and deferred owed rules, DQE's col-B ledger key, the tab-gone report). ci:ui re-run for the new Health row: all stages passed.
Regression scenarios: S28 / S33 / S34 (Pipeline Health rows, the integrated build) -- the import path is unchanged unless the new opt-in is passed, and only makeDateWhole passes it: PASS by inspection. S9 (clasp push from a sibling) -- deploy.sh only appends a stamp token: PASS by inspection.
REGRESSION RISKS:
- makeDateWhole's import re-stages Raw Data with an older date, exactly as Manual Export does; the cdr-report safety-net DQE build then sees an already-built date and its dup guard skips it.
- A stamp written while a project folder had uncommitted edits records those edits in its `trees`; another project can then read "behind" against code that was never committed (the stamp's `+dirty` says so).
- deploy-currency is file-level per project; a project whose last deploy predates G4 reads "not reported yet" until it is deployed with deploy.sh again.
INVARIANTS AT RISK: None. INV-16 untouched. INV-44: no new Pipeline Health step name (the sub-steps log their own rows). INV-17 untouched. The import's force path, M2 / P26 guards and P-3/I-6 ordering are unchanged (G1 never forces).
NET SCORE: 0 − 0 = 0 (G1/G4 are new capabilities, not production fixes; no new failure mode beyond the documented +dirty reading)

OPERATOR ACTIONS / DEPLOY:
- Deploy all three projects with scripts/deploy.sh once so each stamp carries `trees` and the deploy-currency row can read them (it stays muted until then) | BLOCKS DEPLOY: N
- When a date is missing something: CDR Tools -> Make a date whole… with the date (Operator State #56) | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` + Deploy → Manage deployments → New version)
- CDR Import: `scripts/deploy.sh apps-script/cdr-import` (or `cd apps-script/cdr-import && clasp push -f`)
- CDR DQE Pipeline / CDR Reporting Tools: `scripts/deploy.sh apps-script/cdr-report` -- no code change there; deploying it only gives the row its stamp

FOLLOW-ON ITEMS:
- makeDateWhole reads only the six Neon tables it can count; Q Path and CSR Transfer have no Neon table to compare, and NeonCoverage remains the multi-date reconciliation.
- A partially-present core sheet set whose PRESENT rows are wrong is outside G1 by design (Manual Export force); the ledger cannot tell a short day from a truncated one.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
