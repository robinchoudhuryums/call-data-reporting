---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Strategic suggestion #2 — make "what enforces this?" mechanical. Implemented the half that is real (named enforcements must exist); the proposed bullet-level meta-test was measured, found to catch none of the findings it targets, and deliberately NOT built.
Files modified: tests/unit/claude-md-split.test.js, CLAUDE.md

CHANGES:
S#2 | claude-md-split.test.js | Two tripwires: every test / script / ui-harness driver named in CLAUDE.md must exist on disk, and every `docs/*.md` it links must exist. Baseline measured first and clean: 50 enforcement artifacts and 14 doc links, 0 missing — so these protect a currently-true property (the B-2 pattern) rather than describing an aspiration.
S#2 | CLAUDE.md | The C2 corollary now states what enforces C2 itself: the testable half is pinned, and the untestable half is explicitly a human step, with the measurement that says why.

NOT BUILT (and why): the suggestion's headline idea was "a single meta-test over declared conventions" — in practice, "every Common Gotchas bullet must NAME an enforcement or be listed prose-only". It was measured against the three findings it exists to prevent and would have caught NONE. F2's bullet names system-health.test.js six times; F3's names html-include-structure.test.js four times — both score as "enforced". F1's text is not in a bullet at all (it lives in the Key commands block, so the parser never sees it). The real gap is never "this bullet cites no test"; it is "THIS claim has no test, inside a bullet citing a test for a DIFFERENT claim", which no bullet-level regex can see. Building it would have added a check that goes green while its subject is missing — the failure this repo treats as worse than no check. The baseline was also 46 of 84 bullets, so it would have shipped with a 46-wide exemption surface for near-zero signal.

TEST RESULTS: passed — `npm run ci` green: 1239 tests (was 1237; +2), 0 fail, INV-16 guard in sync. Both tripwires mutation-verified across all three reference classes: renaming `insurance-numbers.test.js` fails, moving `docs/conventions.md` fails, and removing `drive-journey.js` fails. The driver case initially did NOT fail — a line filter I had added to skip markdown headings was also skipping the Key-commands bash block, where every driver is named, so that whole class was invisible. The filter was removed and the mutation re-run. This is the same defect the test's own comment warns about, caught because every assertion is mutated rather than assumed.

REGRESSION RISKS: None to production — the diff is one test file and a CLAUDE.md comment; no shipped code. The residual risk is CI-only and intended: renaming or deleting a suite, script, driver or doc that CLAUDE.md names now fails until the reference is updated or the claim removed. That is the point, and the failure message says both remedies.

INVARIANTS AT RISK: None. No cache prefix, aggregation rule, Script Property, or duplicated file touched. CLAUDE.md is 169.9 KB against the 200 KB cap with the per-bullet ratchet green.

NET SCORE: 0 production fixes − 0 new failure modes = 0
(a) Would this have fired in production this month? NO — all 64 references currently resolve; this prevents a future rename from leaving a false guarantee in the doc. (b) New failure mode? NO.

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: N/A — a test and a documentation comment; no Apps Script project's shipped source changed.

FOLLOW-ON ITEMS:
- Two bullets describe a convention whose enforcement EXISTS but goes unnamed: "`neonWrite.js` is duplicated" and "`buildDQEHistoricalData.js` is also duplicated" both say "diff before editing" without naming `scripts/check-duplicated-files.sh`, which enforces exactly that. Cheap C2 wins, deliberately not taken here to keep this change to the mechanism.
- The Neon-outage fallback bounding was PLANNED in this session, not implemented — see STATE.md and the chat plan.

DOCUMENTATION UPDATES NEEDED:
- Done in this session (the C2 corollary's own enforcement scope). No further doc work outstanding.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
