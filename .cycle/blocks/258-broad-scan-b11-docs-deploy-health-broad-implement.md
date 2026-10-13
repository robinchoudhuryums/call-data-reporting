---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- PIPE-7 (owner 2026-10-13, option A) -- a daily run killed after the sheet writes left the date "already in history" with no per-call capture, forever; the catch-up now runs the non-force per-call backfills for that date and keeps it pending while Neon is unreachable
- DEP-2 -- deploy.sh wrote the branch name unescaped into the stamp's single-quoted JS string, and its EXIT trap's `git checkout` could drop an uncommitted stamp-file edit
- DEP-1 -- every playwright install instruction now pins the version CI installs (1.62.1)
- SEC-7 -- cdr-import asks for `drive.readonly` instead of full `drive`
- TOOL-6 -- the dead (and broken) `pullReportData` / dbReporting.js deleted; dbHistorical's header fixed
- DATA-9 -- the `getAllFinalDeptLabels_` comment described its failure behaviour wrongly
- DOC-1 -- `dqeStripParens_` / `dqeFlattenParens_` (CLAUDE.md, INV-24)
- DOC-2 -- S1…S60 (README, fix-history)
- DOC-3 -- README deep links gain /report/outbound, /report/agent-day, /admin/coaching
- DOC-4 -- README: the dashboard's .clasp.json lives at the repo root
- DOC-5 -- CLAUDE.md: "six" split files, not "four"
- DOC-6 -- client-ui-conventions.md: four names that no longer exist
- DOC-7 -- nine stale facts (conventions R49, autoImport comments, ci.mjs count, #49 outbound fallback, dbHistorical ceiling, sidebar 8:30, dataFilters header, Digest footer, runDailyAlerts_ docstring)
Files modified:
- apps-script/cdr-import/autoImport.js, apps-script/cdr-import/appsscript.json
- apps-script/cdr-report/dbReporting.js (DELETED), dbHistorical.js, DQEdrilldown.js, DQEDrilldownSidebar.html, dataFilters.js
- apps-script/department-dashboard/DeptConfig.gs, Digest.gs, Alerts.gs (comments / one email footer string)
- scripts/deploy.sh, tools/ui-harness/ci.mjs, tools/ui-harness/README.md
- tests/unit/pending-imports.test.js, deploy-tooling.test.js, manifest-scopes.test.js, cdr-report-neon-timeout.test.js
- CLAUDE.md, README.md, docs/invariants.md, docs/fix-history.md, docs/client-ui-conventions.md, docs/conventions.md, docs/operator-state.md, docs/per-call-capture.md, docs/architecture.md, docs/module-dependencies.md (regenerated), docs/next-steps.md

CHANGES:
PIPE-7 | autoImport.js | New pendingImportPerCallCatchUp_(iso) runs backfillInboundCalls(iso, iso, false) and backfillOutboundCalls(iso, iso, false). Each skips a date Neon already holds, writes one it does not, and logs its own Pipeline Health row. processPendingImports_ calls it whenever processNewImport returns "ALREADY IN HISTORY". If either backfill reports unreachable or failures, or throws, the date is not remembered: it goes into the existing PENDING_IMPORT_FAILURES ledger (err names PIPE-7), is skipped for the rest of the run, and parks after PENDING_IMPORT_MAX_ATTEMPTS_ like a failed import. Manual Export (force) never reaches this branch.
DEP-2 | deploy.sh | STAMP_BRANCH = the branch with every character outside [A-Za-z0-9._/@+-] turned into `_`, used in the stamp. The EXIT trap restores the stamp file from a mktemp copy taken just before the write (keeping an uncommitted edit and an untracked file); if the copy fails, it says where the pre-deploy copy is.
DEP-1 | README.md, CLAUDE.md, deploy.sh, ci.mjs, tools/ui-harness/README.md | `npm i playwright` → `npm i playwright@1.62.1`.
SEC-7 | cdr-import/appsscript.json, manifest-scopes.test.js | `drive` → `drive.readonly`; its one Drive use (importBulkCSVsFromDrive) only lists and reads. The T-7 suite now maps a Drive READ to drive.readonly and only a Drive WRITE method (create/copy/move/trash/share/overwrite, gated on DriveApp use) to full drive; it still demands `drive` for the dashboard (NeonBackup writes) and `drive.readonly` for cdr-report.
TOOL-6 | cdr-report/dbReporting.js (deleted), dbHistorical.js, cdr-report-neon-timeout.test.js, CLAUDE.md, architecture.md | The file held only pullReportData: no caller, and setString date binds with no ::date cast. The header now lists the real getNeonConn() callers.
DATA-9 | DeptConfig.gs | The comment claimed a config-read error returns the EMPTY union. In fact readDeptConfigRows_ swallows that error (constants, deptConfigReadFailed_), so the union is the roster dept names, consistent with each dept's equally degraded own list. Only a roster-read throw reaches the catch and returns the empty union. Comment only.
DOC-1..7 | docs + comments as listed | As in the findings. Two choices made: the ci.mjs and Digest counts were REMOVED rather than updated ("the asserting drivers…", "has the checklist"), because both drifted every time their list grew.

TEST RESULTS: passed.
- `TZ=America/Chicago node --test`: 2407 tests, 2406 pass, 0 fail (1 skipped, pre-existing).
- `ci:ui` (CI=true): all stages passed.
- Lint clean (75 files: dbReporting.js gone); INV-16 in sync; module map regenerated.
- 9 bites, each failing its test as it should:
  - PIPE-7 ×3: hook removed; unreachable ignored; force passed.
  - DEP-2 ×2: sanitizer widened; trap restore disabled.
  - DEP-1: README unpinned.
  - SEC-7 ×2: manifest back to drive; a Drive write added to cdr-import.
- Regression scenarios: S28/S33/S34 (Pipeline Health / integrated build) are untouched by PIPE-7's normal path, which the "normal import does not run the backfills" test pins. S9 (sibling deploys) is untouched except the playwright pin. No dashboard client file changed.
REGRESSION RISKS:
- PIPE-7: the catch-up now opens Neon for every "already in history" date inside the 14-day window, including dates imported by the bulk path, which writes no per-call rows. That fills a real gap, but costs a read each, plus a write when the date is missing.
- PIPE-7: while Neon is down, such a date retries each catch-up until it parks (the ledger's limit), and the parked row explains it.
- SEC-7: until the operator re-consents, a cdr-import trigger may fail with "Insufficient permissions" (Operator State #9).
- TOOL-6: the remote dbReporting.gs stays live until deleted in the web editor (INV-17); it is harmless dead code.
INVARIANTS AT RISK: None.
- INV-16 untouched (neither duplicated file edited).
- INV-17 handled as an operator step.
- INV-44: no new step name; the backfills log their existing rows.
NET SCORE: 1 − 0 = 1
- Would fire this month: PIPE-7, if a daily run is killed, which the #70 ceiling makes plausible.
- Docs, tooling and least-privilege: the rest.

OPERATOR ACTIONS / DEPLOY:
- cdr-import re-consent (SEC-7): after the push, open the cdr-import Apps Script editor, run any function once and accept the narrower Drive permission (Operator State #9) | BLOCKS DEPLOY: N (do it right after the push, before the next trigger run)
- Delete `dbReporting.gs` in the cdr-report Apps Script web editor (INV-17; `deploy.sh`'s orphan check will name it) | BLOCKS DEPLOY: N
Deploy:
CDR Import: `cd apps-script/cdr-import && clasp push -f`
CDR DQE Pipeline / CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
Department Dashboard: `clasp push -f` from repo root, then a new deployment version (comment/footer-string changes only)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- None new. The batch plan is now fully implemented; what remains are the deferred owner rulings (SEC-1, SEC-2, UX-2, PIPE-8), plus the follow-ons recorded in blocks 254-257:
  - the manager work-window pill (R49);
  - `{ sections: false }` for the other computeSummary_ callers;
  - PIPE-15's fail-open mirrored-date read.
DOCUMENTATION UPDATES NEEDED:
- None beyond those made.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
