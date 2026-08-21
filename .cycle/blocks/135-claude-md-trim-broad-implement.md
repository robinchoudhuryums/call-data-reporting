---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- TRIM | The dedicated CLAUDE.md trim/extraction pass (flagged overdue by the last two /sync-docs
  weight checks; headroom had fallen to 12.8 KB). 187,222 → 175,480 bytes (−11.7 KB; now 171.4 KB
  against the 200 KB budget = 28.6 KB headroom). The five grandfathered bullets are GONE from the
  ratchet map — every prose bullet in both ratcheted sections now fits the flat 4,096 B budget.

Files modified:
- CLAUDE.md                            (the trim itself)
- tests/unit/claude-md-split.test.js   (both grandfathered maps emptied, with the why recorded)
- tests/README.md                      (received the suite enumeration — its designated home)
- docs/operator-state.md               (#19 received the dqe_history index DDL — relocation)

CHANGES (what was cut, and where each removal went):

TRIM-1 | CLAUDE.md Key commands | The `node --test` comment stopped enumerating suites (~3.6 KB):
the suite-by-suite coverage map's designated home is tests/README.md (enriched in the same commit
with every name + one-liner the deleted text carried uniquely). The block keeps the harness
description, the two rules that bite (F-5/F-6 harness strictness; the html-include-structure
whole-file tag-wrap + assembled-client trap), and says explicitly that it stopped enumerating on
purpose. The Cycle Workflow Config "Test Command" parenthetical — a THIRD copy of the same roll —
compressed to the not-covered statement + the tests/README pointer (~1.0 KB).

TRIM-2 | Neon read-back bullet (5,548 → 2,972 B) | Restructured as four numbered rules. Dropped:
the #1–#4 cutover sequence (historical; superseded by "ALL DQE readers are cut over" + the B-2
CI tripwire, which both stay), the B-2 incident retelling (verbatim in fix-history), commit
0403b2c (git history), the 5-min/6-h TTL note (already in the CacheService tiers bullet), and
the index DDL (RELOCATED to Operator State #19 with a fresh-Neon caveat — it existed nowhere
else). Kept: the json_agg one-fetch rule with its ~0.5 s/row justification, LM2, the parity-gate
contract, the getDeptQueueExts_ Neon path, the timing log line.

TRIM-3 | Role model bullet (6,156 B) | SPLIT into four bullets (the documented fusion lesson):
allDepts core / MULTI-DEPARTMENT manager (Tier C) / Multi-row access vs. Overview Parent edge /
ALIAS EMAILS — largest now ~2.6 KB. The four-widening enumeration compressed to "R-3 / R8-4,
fix-history" (verbatim there).

TRIM-4 | Sub-queue combined view KDD bullet (7,547 B) | SPLIT in two: the Phase 1/0/3 combined-
view bullet (~4.0 KB) and a new "Queue-split narrowing (Phase 2) is GATED OFF by default (S2-0)"
bullet (~2.6 KB). The B-1 configuration-fault exposition compressed to the rule + a fix-history
pointer (verbatim there); the client-conventions cross-rules tightened.

TRIM-5 | Neon write discipline (4,881 → 3,782 B) | Rule 4's three incident retellings (IMP-5
phantoms, P-1 stray-leg wipe, F2 empty-set delete) compressed to their rules — every fix code,
caller list, and gate kept; fix-history carries each story. PHI note kept, tightened.

TRIM-6 | Direct-extension bullet (4,848 → 2,962 B) | Build-path enumeration and the P-4/P-5
stories compressed to the guards themselves; the R11-C5 company-card client detail compressed to
one sentence (client surfaces are client-ui-conventions' domain). Dropped as explicitly
hypothetical: the non-force bulk-caller gate note.

TRIM-7 | System Health bullet (kept under the flat budget after the six-engines growth) | LM1 and
the Batch-E row descriptions compressed; all row keys and operator-item numbers kept.

TRIM-8 | claude-md-split.test.js | Both grandfathered maps emptied — the ratchet's documented
target state ("adding an entry is the last resort") — with a comment recording the five retired
seeds and forbidding re-seeding to make room for prose.

REFERENCE-RESOLUTION AUDIT (the Check-5 discipline — every identifier in removed text):
- RELOCATED: the dqe_history CREATE INDEX DDL → Operator State #19; the suite enumeration →
  tests/README.md.
- STILL RESOLVE IN THE LIVE DOC SET: every fix code cited by removed sentences (B-1, B-2, S2-0,
  R-3, R8-4, F-4, IMP-4/5/6, P-1..P-6, L2, F2, C-1, C-6, LM1, LM2, OPS-8, M1, R11-C5/M/B11) has
  its entry in docs/fix-history.md and/or remains cited by the surviving rule text; every Script
  Property, INV reference, and test name in removed text appears elsewhere in CLAUDE.md, its
  split files, or tests/README.md.
- DROPPED WITHOUT A DOC HOME (deliberate, low-risk): commit hash 0403b2c (git history is the
  home); `directAgentRowHtml_`/`directImpact_` (client code symbols, discoverable in
  script-9-inbound-direct.html where their sharing is commented); the hypothetical non-force
  bulk-caller note (self-described as hypothetical).
- NO RULE WAS DELETED. Every cut is narrative, duplication, or a split.

TEST RESULTS: PASSED — 847/847, including claude-md-split (index↔file sync + the now-stricter
flat per-bullet budget + the 200 KB cap) and cache-version-sync's doc scan. No production code
touched — CLAUDE.md, one test's ratchet map, tests/README.md, docs/operator-state.md only —
so ci:ui is not applicable.

REGRESSION RISKS: None in production (docs + guard-map only). Doc risk — a future reader missing
an extracted incident story — is mitigated by the fix-history pointers left in place and the
audit above.

INVARIANTS AT RISK: None. The INV index, Operator State index, and Regression Scenario index are
untouched (the sync guards prove it); INV-16-guarded files untouched.

NET SCORE: 0 − 0 = 0
  (Pure maintenance: every future session pays ~12 KB less context, and the ratchet is now flat —
  no bullet is frozen behind a grandfather entry.)

OPERATOR ACTIONS / DEPLOY: None — documentation and test-guard changes only.
Deploy: N/A (no Apps Script project touched).

FOLLOW-ON ITEMS:
- Common Gotchas is still 101 KB / ~55% of the file. The next size lever, when needed, is another
  F8-style SECTION split (e.g. the Neon pipeline bullets → a docs/neon-pipeline.md with an index),
  not more per-bullet shaving — the bullets are now individually lean.
- The Key Design Decisions INV-30-adjacent bullets (CacheService tiers, Top-tab router) each carry
  detail duplicated in docs/invariants.md / client-ui-conventions.md; candidates for the next pass.

DOCUMENTATION UPDATES NEEDED: None — this WAS the documentation update. (The "How to write one"
habit note's size history sentence still cites the 372→150→178 KB arc, which remains accurate as
history.)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
