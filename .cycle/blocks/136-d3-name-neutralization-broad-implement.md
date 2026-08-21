---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FO-D3 | The one actionable follow-on on the ledger (block 134): dashboardCDR.js wrote
  feed-derived NAMES to the sheet raw — only the CONTACTS cells went through the D-3
  formula-injection neutralizer (`crSheetSafeCell_`). All five raw write sites now route
  through it.

Files modified:
- apps-script/cdr-report/dashboardCDR.js       (5 write sites neutralized)
- tests/unit/dashboard-cdr-core.test.js        (+1 test pinning all sites at once)

CHANGES:

FO-D3 | dashboardCDR.js | `crSheetSafeCell_` applied at: (1) the report table's col-A agent
name (`row = [crSheetSafeCell_(name)]`); (2) the pie-chart temp data block's agent-name labels;
(3) `writeTop5`'s contact-name column; (4) the diagnostics panel's per-category contact-name
rows (`writeDetail`); (5) the diagnostics AGENT SUBTOTALS name column. A feed-derived string
starting with `= + - @ \t \r` (e.g. an agent or caller name crafted as `=IMPORTXML(...)`) now
lands apostrophe-prefixed instead of executing on write. Signed NUMERIC strings stay untouched
per crSheetSafeCell_'s documented design, so phone-number contacts ("+1555…") are not mangled.
Display is unaffected — Sheets renders a leading-apostrophe cell without the apostrophe, and
the pie charts read the rendered text.

TEST DOUBLES: the end-to-end suite's recording fake already captures every cell write, so ONE
test covers all five sites structurally: an agent named `=DROP()` with an `=EVIL(7)` contact —
col A must equal `'=DROP()`, NO cell anywhere in the written grid may hold a bare
formula-leading string, and the neutralized contact must still appear (not just be dropped).

TEST RESULTS: PASSED — 848/848 (+1). dashboardCDR.js passes node --check. No dashboard client
file touched → ci:ui not applicable. INV-16 guard unaffected (dashboardCDR is not a duplicated
file).

REGRESSION RISKS: Minimal. The only behavior change is an apostrophe prefix on formula-shaped
cells — cells that previously EXECUTED as formulas (the vulnerability). A legitimate name
starting with "+"/"-" that is purely numeric is exempted by the helper; a non-numeric one
(e.g. "-- Smith") gains an invisible-at-render apostrophe. Chart labels read rendered text, so
the pies are unchanged.

INVARIANTS AT RISK: None. (Completes the D-3 convention already applied to this file's
contacts cells and to the dashboard's sheetSafeCell_/csvSafeCell_ family.)

NET SCORE: +1 − 0 = +1
  (A real injection surface on a live, menu-run admin tool: agent and caller names come from
  the external CDR feed, and this report writes them into a spreadsheet that admins open.)

OPERATOR ACTIONS / DEPLOY:
- None blocking. | BLOCKS DEPLOY: N
Deploy: CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (rides with the
row-34 sidebar refusal + T-7 clipping fix already awaiting deploy from increments 133–134).

FOLLOW-ON ITEMS (the remaining ledger, all deliberately NOT code work now):
- Owner-gated releases: un-gate Inbound / Direct / Outbound (one-line each after vetting);
  coaching release to managers; QUEUE_SPLIT_SCOPE=dept flip (#42); agent-role go-live (#46).
- Operator steps: deploy the three projects; run previewRow34Overlap once (closes the row-34
  double-count note); Sep-1 backfillInbound/OutboundCalls before runNeonCoverageCheck; arm
  coaching delivery when ready.
- "When needed" doc levers from block 135 (headroom is healthy at 28.6 KB — not needed now):
  the next F8-style section split; the CacheService-tiers / router bullets' duplication.
- The 35+37 overlap inside row 34's ruled sum — surface only if the probe finds a non-zero.

DOCUMENTATION UPDATES NEEDED: None — the D-3 comment at the definition already says the
convention; the code comment added at site (1) records the completion date. (fix-history's
D-3 row still resolves; no doc claimed names were covered, so nothing was stale.)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
