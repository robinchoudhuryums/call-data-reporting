---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F48 (OFB-1): an export run that failed after appending an older date left the outage copy out of date order
- F46 (OFB-2): nothing watched the two outage copies (Inbound Calls, Outbound Calls) or their export runs
- F65 (OFB-3): a backup month written in parts was frozen as final after a failed part
- F59 (OFB-4): the retention prune's proof of import was narrower than what is built from a Call_Legs tab
- F47 (OFB-5): the export tabs carried empty columns and a wrong cell-cap rationale
New capabilities (G/ST): None
Files modified:
- apps-script/cdr-report/inboundCallsExport.js
- apps-script/cdr-report/outboundCallsExport.js
- apps-script/cdr-import/DeleteOldSheets.js
- apps-script/department-dashboard/NeonBackup.gs
- apps-script/department-dashboard/SystemHealth.gs
- tests/unit/inbound-export.test.js, neon-backup.test.js, retention-prune.test.js, system-health.test.js
- tests/unit/snapshots/ch4-payloads.json (regenerated: two new Health rows)
- tests/README.md, CLAUDE.md, docs/fix-history.md, docs/next-steps.md, docs/operator-state.md, docs/module-dependencies.md

CHANGES:
F48 / OFB-1 | inboundCallsExport.js, outboundCallsExport.js | The final sort runs for any run that appended rows, failed or not. A no-argument run checks the date order before it connects and re-sorts an out-of-order tab, so the repair works while Neon is down. Changed-date progress is stored per date: the whole plan goes into the PENDING property (and the watermark moves) before the first older date is read, and each finished date leaves PENDING as it lands.
F46 / OFB-2 | SystemHealth.gs | Two new Health rows in the Sheets section, `fallback-inbound` and `fallback-outbound`: the date the copy runs through, workdays behind the latest daily data (one is normal, two warns), whether the tail is out of date order, the last `inboundExport` / `outboundExport` run (none on record = the export is probably not installed), and the tab's cells against the 10M cap. Sheet-only, fast half. Muted when Neon is not configured and the tab does not exist.
F65 / OFB-3 | NeonBackup.gs | Part files are written last part first, part1 last. part1's date is the month's finality stamp, so a run that stops short leaves the month unstamped and the next run writes it again.
F59 / OFB-4 | DeleteOldSheets.js | A tab that passes every existing check gets one more right before the delete, under the import's script lock: DQE history must hold the date, or Pipeline Health must show the date's newest DQE build as a success; Direct Call History is rebuilt from the tab if its sheet lacks the date; the per-call backfill runs for the date if Neon lacks it (Neon probed once per run; skipped when Neon is not configured). A tab that still owes one is kept and named in the `retentionPrune` row; with the lock busy or past 2.5 minutes of checks the remaining tabs wait a night.
F47 / OFB-5 | inboundCallsExport.js, outboundCallsExport.js | Each export run deletes the empty columns right of its headers (a new tab is 26 wide; Inbound uses 24, Outbound 12); a column holding anything is left alone. The comment and Operator State #49 no longer say the journey window sizes the tab against the cell cap: it bounds bytes, and the keep days set the cells.

TEST RESULTS: passed -- 2976 pass, 0 fail, 1 skipped (pre-existing) under TZ=America/Chicago; INV-16 guard in sync; lint:gas clean; module-deps --check clean; ci:ui all stages passed. 15 new tests; three existing retention tests and one export source pin were updated on purpose (they pinned the old proof and the old PENDING write). 12 bite checks, all bite.

REGRESSION RISKS:
- OFB-4: the prune now reads DQE history on every night a tab is over-age (it used to skip the read when the memo proved the tab), and it can write (a Direct rebuild, a per-call backfill) while holding the script lock. An import that starts in those seconds waits or is skipped until its next trigger.
- OFB-4: while Neon is down no over-age tab is deleted, so a long outage grows the import workbook.
- OFB-4: a day with no DQE rows AND no DQE build row in the newest 6,000 Pipeline Health rows is held for good until someone clears it. Normal quiet days log a rows:0 success and are pruned.
- OFB-2: installs whose copy is two or more workdays behind, or missing while Neon is configured, gain a warn row.
- OFB-1: the watermark now moves before the older dates finish; they are carried in PENDING instead of being re-asked for.

INVARIANTS AT RISK: None broken. INV-44: no new step names; the `retentionPrune` notes gained two segments, and OFB-4 now depends on the DQE build's log notes starting with the date (pinned in retention-prune.test.js). CH-4 Health golden regenerated on purpose.

NET SCORE: 0 − 1 = −1
(None of the five could be shown to have fired this month: each needs a failure during an outage or a rare size. The one new failure mode is OFB-4's: the prune can now hold tabs and do writes. The batch buys outage-time correctness, which this tally does not count.)

OPERATOR ACTIONS / DEPLOY:
- Push cdr-report, then CDR Tools -> Inbound Calls Tab -> Refresh now and Outbound Calls Tab -> Refresh now once (re-sorts if needed, drops the empty columns) | BLOCKS DEPLOY: N
- Deploy the dashboard, open Admin -> Health and read the two "Outage copy" rows; if either says no export run on record, install the daily export (#49 / #50) | BLOCKS DEPLOY: N
- Push cdr-import; the next morning read the `retentionPrune` row for "KEPT ... still owed something built from the tab" and clear any with CDR Tools -> Make a date whole (#43) | BLOCKS DEPLOY: N
- Decide the keep days for the Outbound Calls tab from its Health row: at the documented ~3,800 outbound rows a day, 400 days at 12 columns is more cells than the workbook's whole cap | BLOCKS DEPLOY: N
- A backup month frozen with parts missing before this deploy is not detected; if one is suspected, trash its part1 file and run the backup (#28) | BLOCKS DEPLOY: N
Deploy:
- CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f`
- CDR Import: `cd apps-script/cdr-import && clasp push -f`
- Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Outbound Calls tab's default 400-day keep looks too large for the cell cap at current volume; lowering the default deletes rows, so it is left as an owner decision.
- The Health rows check only the newest 500 rows of each tab for date order; an out-of-order block higher up is not seen there (the export's own pre-connect check reads the whole column).
- A backup month already frozen incomplete cannot be told from a complete one; a part count stored with the month would make that checkable.
- The prune's kept tabs are named in a success row; a tab held for many nights is not escalated to a failure or an email.
- The pending-import loop's catch-up still attempts a backfill per date per run during a Neon outage (the prune now probes once).

DOCUMENTATION UPDATES NEEDED:
- None (fix-history row OFB-1..5, next-steps row, Operator State #28 / #43 / #49 / #50 / #62, CLAUDE.md index lines and the Health row list, tests/README.md were updated in the batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
