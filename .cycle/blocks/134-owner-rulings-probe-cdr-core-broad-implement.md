---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented (three owner go-aheads, 2026-08-20):
- OR-1 | Option C RULED: the Outbound report's company view stays the flat table (per-dept cards
  rejected — crossover agents make card grouping double-count or misattribute). Ruling recorded
  at the render site; follow-on CLOSED.
- OR-2 | Row-34 read-only probe: `previewRow34Overlap` (cdr-import, CDR Tools menu) scans every
  surviving Call_Legs_* sheet and counts the internal+status-3 double-count shape; pure core
  behaviorally PINNED to calcQcdReport's own row 35/37 counters.
- OR-3 | dashboardCDR.js coverage gap RESOLVED: 9-test end-to-end suite over
  generateCustomReportCore_ — which immediately EXPOSED AND FIXED a real clipping bug (the
  T-7 panel clear wiped fresh report columns on narrow-run → wide-run sequences).

Files modified:
- apps-script/cdr-import/autoImport.js        (countRow34OverlapRows_ pure core +
                                               previewRow34Overlap editor probe)
- apps-script/cdr-import/CDR Tools.js         (menu item "Preview QCD row-34 overlap")
- apps-script/cdr-report/dashboardCDR.js      (the T-7 clear FIX: split strip/beyond-edge clear,
                                               writeDiagnostics gains reportWidth param)
- apps-script/department-dashboard/script-9-inbound-direct.html (Option C ruling comment only)
- tests/unit/qcd-sidebar-parity.test.js       (+2 probe tests incl. the behavioral cross-pin)
- tests/unit/dashboard-cdr-core.test.js       (NEW — 9 tests, local recording fake)

CHANGES:

OR-2 | autoImport.js + CDR Tools.js | `countRow34OverlapRows_(cleanData)` copies the pipeline's
own predicates (incl. the global start/end guard): e35 = A_Q_ + status 3 + abandoned > 1 min +
in-window; e37 = internal + in-window + end < 3 PM + A_Q_ + abandoned > 1 min; overlapE counts
rows satisfying BOTH — the exact population row 34's ruled sum counts twice. `cOverlapMax` is the
col-C analogue WITHOUT r37_C_p1's `!isCSR` check (needs the csr_team named range) — a SUPERSET,
so 0 proves col C clean too. `previewRow34Overlap()` (editor-run + menu, READ-ONLY: no writes,
no properties) logs per surviving Call_Legs date and a total with a plain verdict line ("provably
CLEAN" / "OVERSTATES by N"). The parity suite pins the pure core two ways: expected counts on a
6-row shape fixture, AND probe-vs-pipeline equality — countRow34OverlapRows_'s r35/r37 counters
must equal calcQcdReport's own written row 35/37 E cells on the same fixture, so a pipeline rule
edit not mirrored into the probe fails CI.

OR-3 | tests/unit/dashboard-cdr-core.test.js | The C1 fixture treatment: a LOCAL recording fake
(deliberately not an extension of the shared strict harness — ~40 cosmetic chainables would
loosen it for everyone; real behavior modeled: cell reads/writes, A1 ranges, value-vs-DISPLAY
grids, getLastRow/Column, chart-insertion counts, Proxy default for cosmetics) drives the REAL
core end to end. Pins: non-comp + comparison header shapes; aggregation from the (N) list
multipliers; rate/TTT/ATT derivation with TTT read from DISPLAY strings while the values grid
holds junk 1899 Dates (the F-11 fix, now enforced); the derived B6 comparison end date; exact
dept match (substring dept excluded); specificAgent filter; zero-activity drop; sort; the D-3
formula-neutralized contacts cell; the D-6 validation alerts + button restore; the empty-result
message; diagnostics summary counts + CRB_DIAG_COL; chart count.

OR-3 FIX (exposed by the new suite) | dashboardCDR.js | The T-7 full-height panel clear ran
AFTER step 7 rendered the fresh table and cleared cols prevCol..prevCol+2 over the report's full
height — so a narrow run (panel remembered at e.g. col 13) followed by a WIDER comparison run
(15 cols) wiped the fresh report's TTT (P)/ATT (C)/ATT (P) columns: the REP-1 clipping class,
reintroduced by T-7. Fix: the strip ABOVE the report (rows 1..11) is always cleared; below that,
only the old-panel columns BEYOND the render step's own clear (max(45, width+1) — always past
the fresh report's right edge, so provably safe) get the full-height wipe. Both prior behaviors
pinned: the wide-report columns survive (regression test) AND a stale beyond-col-45 panel is
still fully cleared (the original T-7 case).

OR-1 | script-9-inbound-direct.html | Comment at the company-view render: Option C ruled — flat
table with the multi-home "Roster dept" label; don't "upgrade" to per-dept cards without a new
ruling (cards must double-count or misattribute crossover agents).

TEST RESULTS: PASSED — 847/847 (was 836; +11: 2 probe + 9 core). INV-16 guard green (the
dataFilters/autoImport compared functions untouched). autoImport.js + dashboardCDR.js pass
node --check. `npm run ci:ui`: re-run for the script-9 comment — result in the commit gate
(comment-only client change; the assembled-client node --check in npm test already covers it).

REGRESSION RISKS:
- The T-7 fix changes WHEN full-height clearing happens: panels at cols ≤ max(45, width+1) now
  get strip-only clearing, relying on the render clear for rows ≥ 12 — which is exactly what the
  render clear does (60+ rows × ≥45 cols). The boundary case (panel straddling col 45) clears
  only its beyond-edge columns below row 11; the straddling columns ≤ 45 are handled by the
  render clear. Both directions test-pinned.
- writeDiagnostics gained a parameter; single caller updated in the same commit (Apps Script
  extra/missing args are non-throwing anyway — reportWidth||0 guards the standalone case).
- The probe is read-only by construction (no setValue/setProperty anywhere in it).

INVARIANTS AT RISK: None. The probe reuses autoImport's own top-level simulateSplitCol2/
parseDurationDecimal (no new duplication; the INV-16-guarded pairs untouched). Sheet outputs
byte-identical everywhere except the FIXED clipping (which was data loss, not intended output).

NET SCORE: +1 − 0 = +1
  (The clipping bug is real and fires in production TODAY on any narrow-then-comparison report
  sequence — the comparison report's last three columns silently blank. Found only because the
  owner commissioned the coverage.)

OPERATOR ACTIONS / DEPLOY:
- RUN THE PROBE once after deploying cdr-import: CDR Tools → "Preview QCD row-34 overlap"
  (execution log shows the verdict). Zero over the ~14-day window ⇒ close the known-issues
  double-count note as "latent only". | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (probe + menu item).
CDR Reporting Tools: `cd apps-script/cdr-report && clasp push -f` (the dashboardCDR clipping fix).
Department Dashboard: comment-only — rides the next deploy.

FOLLOW-ON ITEMS:
- Agent NAMES are written raw into the report table col A and the diagnostics agent subtotals
  (only CONTACTS go through crSheetSafeCell_, D-3) — a feed-derived agent name starting with `=`
  would execute on write. Same neutralization one-liner ×3 sites when taken; noted, not fixed
  (out of the commissioned scope).
- Probe result → if non-zero, the owner rules on adding `type !== "internal"` to row 35's E
  predicate (a two-file pipeline+sidebar edit, parity-covered).

DOCUMENTATION UPDATES NEEDED (next /sync-docs):
- known-issues "QCDR Output row 34": add the probe as the resolution instrument (run it, then
  close as latent-only or escalate).
- tests/README.md: dashboard-cdr-core.test.js + the parity suite's probe family.
- CLAUDE.md test-suite roll: dashboard-cdr-core; the block-130 "480-line core stays a follow-on"
  clause is now RESOLVED.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
