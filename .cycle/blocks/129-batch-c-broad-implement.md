---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- C1 (F7/F1 class) | Behavioral parity suite over the two hand-mirrored QCD rule sets
  (dataFilters.js Extraction Sidebar ↔ autoImport.js calcQcdReport) — the guard that would have
  caught F1 behaviorally, and the first test coverage EVER on dataFilters.js
- C2 | The "what enforces this?" corollary added to CLAUDE.md's bullet-writing habits
- C3 (F8) | The `time1Min` "~59s" misnomer corrected — the rule is "MORE than 60s"

Files modified:
- tests/unit/qcd-sidebar-parity.test.js   (NEW — 4 tests)
- apps-script/cdr-import/autoImport.js    (comment-only: the R20 block's threshold wording)
- CLAUDE.md                               (habit-3 corollary, ~600 B)

CHANGES:

C1 | tests/unit/qcd-sidebar-parity.test.js | ONE shared synthetic Raw Data fixture (21 rows across
the primary/child/stat3/DNIS/global/row-39-40 rule families) drives BOTH implementations end to
end: `calcQcdReport(cleanData, targetSS)` returns the QCDR Output grid; `getExtractionDataJSON()`
is then driven per cell against a fake QCDR Output sheet holding THAT grid (the production
relationship — the sheet the sidebar reads is what the pipeline wrote). The parity property: for
every directly-written drillable count cell (rows 3,4,5,6,13,35,36,37,39,40,43 × cols C/D/E),
sidebar extracted-row count === pipeline cell value, and a zero cell must REFUSE with the zero
message. NO expected numbers are hardcoded in the parity test, so a rule edit in EITHER file that
is not mirrored in the other fails regardless of which of the ~50 rules it was. Two anchored tests
on top: the R20 boundary row (a 30s Spanish abandon counted by NEITHER side — pins against BOTH
files regressing together, which pure parity would miss) and the row-39 netting (a CSR-team row on
the shared queue moves between rows, never doubles). A sanity test requires every family nonzero so
a refactor cannot turn the suite into 33 vacuous 0===0 passes.
NEGATIVE-TESTED FROM BOTH SIDES: reverting the sidebar's t2 to the pre-R20 >0s rule fails with
"(40,3): pipeline wrote 4 but the sidebar extracted 5"; perturbing a PIPELINE rule (child 20s
threshold) fails with "(6,3)/(6,5)" mismatches. Restored clean: 4/4.

C3 | apps-script/cdr-import/autoImport.js | The R20 comment called the >1min rule "(~59s)" — 
backwards: time1Min is exactly 1/1440 day = 60s and the comparison is strict >, so a 60.0s wait is
EXCLUDED. Comment now states ">MORE than 60s" and adds the load-bearing distinction discovered
while fixing it: the editor-run AbandonedFilter.js menu tools use a SEPARATE, deliberate >0:00:59
threshold — the two differ by the 1-second class ON PURPOSE and must not be "synced".
Comment-only diff (8 insertions, 2 deletions); the F2 row-40 pin and the new parity suite both
still pass over the edited block.

C2 | CLAUDE.md | Habit 3 of the "How to write one" note gains the corollary: when a new convention
is WRITTEN, answer "what enforces this?" in the same commit and name the enforcement in the bullet
— citing the three holes one audit found (F2: a third duplication pair outside the INV-16 guard;
F3b: two cache prefixes documented in INV-30 but absent from cache-version-sync's SPECS; F11: a
second read-source dimension with no B-2-style tripwire). "None — prose only" is an acceptable
answer; an unanswered question is not.

TEST RESULTS: PASSED — 783/783 (was 779; +4). INV-16 guard green. autoImport.js passes
`node --check`. CLAUDE.md index↔file sync + per-bullet ratchet green (178.7 KB, 21.3 KB headroom;
the habit list is preamble, not a ratcheted bullet). No client file changed, so ci:ui has nothing
new to cover. Manual Regression Scenarios: none apply — no production behavior changed (one test
file, one comment, one doc note).

REGRESSION RISKS: Effectively none — no production logic changed.
- The parity suite adds ~2s to `node --test` (loads autoImport.js 3.6K lines + dataFilters.js into
  two vm harnesses once at module scope).
- The suite is deliberately fixture-scoped: all rows sit mid-window (10:00 AM). Window-EDGE
  divergences between the two files are real and pre-existing (see follow-ons) and are NOT covered;
  the scope note in the file says so, so a green run cannot be over-read.
- The two anchored tests (row-40 = 4/2, row-39 = 1) DO hardcode expected values, so a deliberate
  future rule change to row 40 will require updating them — that is the point (the R20 class must
  not change silently), and the assertion messages say which owner ruling they pin.

INVARIANTS AT RISK: None.
- INV-16: the guard is untouched and green; the parity suite runs each file's OWN copy of the
  shared time-decode helpers in separate vm harnesses, exactly as production does.
- The C3 comment sits inside the q40 block that cross-file-pins brace-matches — verified the
  extraction still resolves and the token pin still passes.
- No cache key, payload, gate, or write path touched anywhere.

NET SCORE: 0 − 0 = 0
  (Nothing here fires in production this month — C1 is pure prevention: the ~1,700 lines of live,
  menu-reachable, zero-test cdr-report code now has its highest-risk rule surface behaviorally
  pinned from both sides. C3 is a comment; C2 is process. The score understates the value the same
  way F2's guard did before F1 proved the class fires.)

OPERATOR ACTIONS / DEPLOY:
- cdr-import's diff is COMMENT-ONLY — no behavior change, so no urgency; it rides along whenever
  the next real cdr-import change deploys. | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (comment-only, optional/ride-along).
Dashboard / cdr-report: nothing to deploy (test + docs only).

FOLLOW-ON ITEMS (all pre-existing production discrepancies FOUND by building C1 — reported, not
fixed, per the audit rules):
- ROW 34 IS INCOHERENT ACROSS THE THREE SURFACES. calcQcdReport counts r34_abnd1m/r34_abnd2m and
  writes them NOWHERE (dead counters — totalRowMap overwrites row 34 as the SUM of rows 35-37),
  while the Extraction Sidebar has a live row-34 predicate of its own (abandoned >1m, isAQ,
  non-steering) that matches a DIFFERENT population than sum(35,36,37) — e.g. a status-3 INTERNAL
  abandon >1m is counted by BOTH r35_E_1m and r37_E_1m (so the row-34 total counts it twice) but
  extracted once by the sidebar. Also the sidebar's total-row refusal list omits 34 (it refuses
  2,7,10,...,47 but not 34), so users CAN drill a total row there and get non-reconciling rows.
  Needs an owner ruling on what row 34 MEANS before any code moves.
- WINDOW-EDGE DIVERGENCE, row 35: the sidebar's dp2/dp3 (col D) predicates lack the pipeline's
  `start < 3:00 PM` clause (`startDec < time300PM`) — a status-4/5 incoming row starting at e.g.
  15:10 with end < 15:30 counts in the sidebar's col-D extraction but not the pipeline's r35_D_p2/3.
  Same drift class as F1, at the window edge. Two-file fix + extend the parity fixture with
  edge-time rows when taken.
- AbandonedFilter.js (>0:00:59) vs calcQcdReport (>1:00) differ by the 1-second class. Now
  documented as deliberate at the R20 comment; if the owner ever rules they should agree, that is
  a one-line AbandonedFilter change.
- dashboardCDR.js (1,073 lines, 4 setValues sites) remains zero-test — C1 covered dataFilters.js,
  the higher-risk half of F7. The same fixture-driven approach would work there.

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Key Commands test-suite roll: add qcd-sidebar-parity to the suite enumeration (the
  Extraction Sidebar gotcha bullet's "the rest of the row rules are not [pinned]" clause is now
  PARTLY stale — the row rules ARE behaviorally pinned for mid-window rows; the bullet should say
  the parity suite covers them and name the row-34 / window-edge exceptions).
- tests/README.md coverage map: same addition.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
