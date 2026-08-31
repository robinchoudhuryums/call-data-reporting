---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F-A | The Call_Legs_* retention prune (Operator State #43) had ZERO tests despite being the only irreversible-deletion path in the repo
- F-B | cdr-report/DQEdrilldown.js is a FOURTH hand-mirrored copy of the pipeline's rules with no guard of any kind (not in check-duplicated-files.sh, not in cross-file-pins)

Files modified:
- tests/unit/retention-prune.test.js (new, 14 tests)
- tests/unit/dqe-drilldown-parity.test.js (new, 13 tests)
- tests/harness/fakeSheet.js (added deleteSheet to makeFakeSpreadsheet)
- tests/README.md (coverage map -- enforced by claude-md-split.test.js)

NO production source was modified. `git status` confirms tests-only.

CHANGES:
F-A | tests/unit/retention-prune.test.js | Pins, in order of what a defect
     would cost: (1) non-Call_Legs tabs are untouchable, incl. the
     'Archive_Call_Legs_*' prefix-at-nonzero-index and undated near-misses;
     (2) the 14-day cutoff is EXCLUSIVE (exactly-14 kept, 15 deleted) and a
     future-dated tab is kept; (3) P18 -- an unbound context THROWS rather
     than reporting a green "deleted 0" while the retention window silently
     stops being enforced; (4) the retentionPrune Pipeline Health row carries
     the accurate deleted count, logs a failure row without rethrowing, and
     survives a logger that is absent or throws. Plus a bulk run over 40
     interleaved tabs.
F-A | tests/harness/fakeSheet.js | makeFakeSpreadsheet gained deleteSheet,
     modelled not stubbed (a no-op stub would make every prune assertion pass
     vacuously). Removes by IDENTITY and throws for a foreign sheet, matching
     the real API.
F-B | tests/unit/dqe-drilldown-parity.test.js | ONE shared synthetic Raw Data
     fixture drives the REAL build and the REAL drill sidebar in one context.
     For every drillable column the drill's rowCount (its "Found N", the
     number an operator reconciles by hand) must equal the DQE cell the build
     wrote. No expected values hardcoded. Fixture is shaped so the metrics are
     not interchangeable (P5 rings twice so rung != unique; Bob's 999s leg
     shares P1 as the INV-08 decoy; Q4 sits outside the work window), and a
     fixture guard fails if that ever degenerates.

TEST RESULTS: passed. Full suite 1051/1051, `npm run ci` green (incl. the
INV-16 duplicated-files guard). Both new suites were MUTATION-TESTED rather
than assumed effective:
  retention-prune -- 4 of 5 mutations caught (boundary >= for >, prefix match
    anywhere, P18 silent no-op, health row reporting kept instead of deleted).
    The 5th (forward loop) was NOT caught, and that is correct: getSheets()
    returns a snapshot, so deletion cannot shift un-visited entries. The test's
    name and comment were corrected to stop claiming it guards an index-shift
    hazard the API's semantics rule out.
  dqe-drilldown-parity -- reverting each of the three historical drifts fails
    the suite: F24 (canonicalize_ -> identity) 2 failures, R8-D4 (strip key
    only, dropping the flatten candidate) 1 failure, F-13 (unique/ttt/att
    unwindowed) 2 failures, INV-08 (max-across-legs attribution) 5 failures.

REGRESSION RISKS: Low, and bounded by construction -- no production file was
touched. The one shared-surface change is fakeSheet.js's new deleteSheet.
Nothing called it before (it did not exist, so any caller would have thrown),
and the full suite is green, so no existing suite depended on its absence.

INVARIANTS AT RISK: None. Three are STRENGTHENED -- INV-08 (own-leg talk
attribution), INV-24 (strip+flatten canonicalization union) and INV-06/07 (the
work window) are now pinned behaviorally in the drill sidebar, where they were
previously only pinned in the build.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(Deliberate: these are guards, not fixes. The one real bug found is filed as a
follow-on below rather than fixed here, per the "flag, don't fix" rule.)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: N/A -- tests only; no Apps Script project content changed, so no
`clasp push` is required for this change.

FOLLOW-ON ITEMS:
- REAL BUG (found, characterized, NOT fixed): the prune deletes a day EARLY
  across the fall-back DST transition. deleteOldCDRSheets computes
  (todayLocalMidnight - sheetLocalMidnight) / 86_400_000, so a window
  containing a 25-hour day yields 14.0417 for a nominally-14-day-old tab,
  which clears `> 14`. Effective retention narrows to 13 days for ~2 weeks
  after each November transition -- against a window Operator State #40's
  queue-split backfill already races, and the deletion is irreversible.
  Verified empirically under TZ=America/Chicago; invisible under the host's
  UTC, which is why the test forces the zone and asserts the zone took effect.
  Proposed fix (one line): compare whole days,
  Math.floor((Date.UTC(ty,tm,td) - Date.UTC(sy,sm,sd)) / 86400000).
  tests/unit/retention-prune.test.js carries a CHARACTERIZATION test whose
  failure message says to delete it and fold the date into the boundary test
  once the fix lands.
- Minor robustness: out-of-range date components in a tab name roll over
  silently (Call_Legs_2020-13-99 -> 2021-04-09; Call_Legs_2026-99-01 ->
  2034-03-01), so a malformed name is aged as whatever it normalises to, in
  either direction. Harmless while names are machine-generated. Pinned as
  documented behaviour.
- Still-uncovered files from the same survey, not in this scope:
  cdr-report/insuranceNumbers.js (11 KB, syncInsuranceNumbersToNeon feeds the
  Inbound report's insurer labels) and department-dashboard/NeonKeepWarm.gs
  (the only unloaded dashboard file; cost-shaped -- a window-gate bug means
  24/7 pings against the ~190h free allowance, or silent no-warm).
- Client gap: the Dept Config / Orphan Fix / Alerts admin modals and the
  Escalations worklist MUTATIONS have server-side pins but no asserting
  ui-harness driver -- the same class that shipped the header dept-selector
  ReferenceError (server-correct, unreachable from `node --test`).

DOCUMENTATION UPDATES NEEDED:
- CLAUDE.md Common Gotchas: the "Extraction Sidebar mirrors the pipeline's QCD
  rules BY HAND -- a THIRD duplication" bullet should name DQEdrilldown.js as
  the FOURTH, now guarded by dqe-drilldown-parity.test.js. Per the C2 rule the
  enforcement must be named in the bullet. Left for /sync-docs rather than
  bundled here, since the /broad-implement scope was the two test suites.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
