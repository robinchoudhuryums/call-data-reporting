---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: the four FOLLOW-ON ITEMS from block 158.
- FO-1 | REAL BUG: the retention prune deletes a day EARLY across the fall-back DST transition
- FO-2 | Minor robustness: out-of-range date components in a Call_Legs_* tab name roll over silently
- FO-3 | The two remaining never-loaded source files (NeonKeepWarm.gs, insuranceNumbers.js)
- FO-4 | Client gap: the admin modals + Escalations worklist had no ASSERTING ui-harness driver

Files modified:
- apps-script/cdr-import/DeleteOldSheets.js  (the ONLY production change)
- tests/unit/retention-prune.test.js         (characterization -> regression)
- tests/unit/neon-keepwarm.test.js           (new, 15 tests)
- tests/unit/insurance-numbers.test.js       (new, 14 tests)
- tools/ui-harness/drive-admin.js            (new asserting driver, 41 checks)
- tools/ui-harness/ci.mjs                    (wire it in as a gate stage)
- tools/ui-harness/README.md, CLAUDE.md, tests/README.md  (stage + coverage map)

CHANGES:
FO-1 | DeleteOldSheets.js | Age is now compared in WHOLE CALENDAR DAYS via
     Date.UTC on each side's local y/m/d, instead of dividing a local-midnight
     millisecond difference by 86_400_000. The old form was DST-sensitive: a
     window containing the 25-hour fall-back day yielded 14.0417 for a
     nominally-14-day-old tab, clearing the `> 14` cutoff. The change is
     strictly LESS-deleting or equal in every case, which is the only safe
     direction for an irreversible delete. The characterization test written
     in block 158 was replaced by a real regression test (plus its
     complement: the day AFTER the cutoff must still prune across the same
     transition, so the fix cannot degenerate into "stop deleting near a
     transition").
FO-2 | DeleteOldSheets.js | A tab name whose date components are out of range
     is now SKIPPED rather than normalised. Date.UTC(2020, 12, 99) is a real
     timestamp (2021-04-09), so a nonsense suffix used to be aged as whatever
     it rolled over to and could be deleted on that basis. A range check plus
     a round-trip (which also catches Feb 30 / Apr 31) means "this name is not
     one I understand, so I will not act on it". Trade-off accepted and
     documented in the code: a hand-made bad name now accumulates instead of
     ageing out -- visible and harmless, unlike deleting on a date nobody
     wrote. A leap-day test guards against an over-strict validator silently
     skipping one real day a year.
FO-3 | tests/unit/neon-keepwarm.test.js | The engine is COST-shaped and every
     failure mode is silent, so the suite asserts ONE observable: did this
     invocation open a Neon connection? Across the enable flag (exact string
     'true' only), weekends, the HALF-OPEN hour window (start pings, end does
     not -- an inclusive end silently widens the monthly budget by an hour a
     day), a typo'd hour property that must NARROW to the default rather than
     widen to 24/7, and an inverted window. Plus the NEO-3 contract that the
     ping passes { skipReadHealth: true } so a keep-warm failure cannot
     masquerade as a sticky DQE read-back failure. Wall-clock hours are pinned
     by searching for the instant that maps to a given TZ-local hour, so the
     suite is offset- and DST-independent rather than asserting against the
     runner's zone.
FO-3 | tests/unit/insurance-numbers.test.js | Pins the normalizer input by
     input (every punctuation variant collapsing to one canonical form, REP-7's
     10-digit country-code fix, short entries dropped, unnamed columns
     ignored), the PHI contract that ONLY the hash and the label reach Neon,
     the full-replace + hash-dedupe semantics, and both abort-before-connecting
     paths. Also asserts CROSS-PROJECT hash equivalence between cdr-report's
     hashPhone and cdr-import's cdrHashPhone_ -- two hand-maintained copies in
     different projects that check-duplicated-files.sh does not cover, whose
     divergence would silently unlabel every insurer.
FO-4 | tools/ui-harness/drive-admin.js | Asserting driver over the six admin
     modals and the Escalations worklist: each modal opens, renders content,
     traps focus over 25 tabs, closes on Escape and fits the viewport, with no
     page or console errors; Escalations renders its cards, gives an admin the
     dept filter, and never duplicates its nav badge across re-entry (F10).
     Wired into ci.mjs as a blocking stage.

TEST RESULTS: passed.
- `npm run ci`: 1082/1082 unit tests + the INV-16 guard, green.
- `drive-admin.js`: 41/41 checks, run end to end against the real built site.
- Mutation-tested throughout, and the mutations found two things worth naming:
  (a) the driver's first draft PASSED the focus-containment and Escape checks
      against a selector matching nothing (`inside` came back null, which is
      never === false, so the escape counter stayed 0). A check that goes
      green when its subject is absent is the exact failure this driver
      exists to prevent; both are now gated on the modal having opened.
  (b) that vacuous pass was masking a REAL find: `#system-health-modal` does
      not exist. The router table in script-4-nav.html names it
      `#health-modal`, and the exploratory drive-phase3.js has been probing
      the wrong id for as long as it has existed -- invisibly, because it
      records failures instead of raising them. Selectors are now read off the
      router, which is the authority.

REGRESSION RISKS: One production file changed, and its behaviour change is
one-directional: the new comparison deletes strictly LESS than the old one
(equal in every non-DST case, one day later across a fall-back window), and
rejected names are kept rather than deleted. There is no input for which the
new code deletes something the old code kept. `kept` can now be lower for
malformed names, since a rejected tab is skipped rather than counted -- that
figure only feeds the Pipeline Health note, and it is asserted.

INVARIANTS AT RISK: None. The prune is not part of any INV-16 duplication pair
(single file, single caller, verified). NEO-3's skipReadHealth contract and
REP-7's normalization are now pinned rather than merely documented.

NET SCORE: 1 production fix (FO-1, a real early-deletion bug against an
irreversible operation) + 1 hardening (FO-2) − 0 new failure modes = +2

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`
(DeleteOldSheets.js is the only changed project file. Everything else is
tests + harness, which never ship.)

FOLLOW-ON ITEMS:
- drive-phase3.js still lists `sel: '#system-health-modal'`. It is exploratory
  and non-blocking, so its report simply says `{ found: false }` for that
  modal; left alone because fixing it is outside this scope, but its report is
  wrong today and anyone reading it should know.
- The `// Reverse loop so deletions don't shift the un-visited entries.`
  comment in DeleteOldSheets.js describes a hazard that getSheets()'s snapshot
  semantics rule out (established by mutation in block 158). The loop is
  correct either way; only the comment overstates.
- drive-admin.js boots a fresh browser context per modal (~30 s each, ~4 min
  total). Fine as a CI stage, slow to iterate on locally; could share one
  context if the gate's wall-clock becomes a problem.

DOCUMENTATION UPDATES NEEDED:
- Done inline where the change made existing text FALSE: CLAUDE.md's "SEVEN
  ASSERTING stages" is now EIGHT with the new stage described, and the
  ui-harness README gained the driver (its "the two asserting drivers" /
  "all four of them" counts were already stale and are now countless rather
  than wrong).
- STILL OPEN from block 158: CLAUDE.md's "Extraction Sidebar ... a THIRD
  duplication" bullet should name DQEdrilldown.js as the FOURTH, now guarded
  by dqe-drilldown-parity.test.js. A /sync-docs item.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
