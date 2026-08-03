---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- Extraction pass on the 8 biggest Common Gotchas bullets (narrative -> fix-history, rules stay)
- Suggestion 1 | Enforce the declared "CLAUDE.md = rules / fix-history = why" separation
- Suggestion 2 | Replace the size CLIFF with a per-bullet leading indicator (ratchet)
- Suggestion 3 | Make /sync-docs prune, not only append (CHECK 5)
- Suggestion 4 | Document the phased-rollout writing convention that produced the biggest bullets

Files modified:
- CLAUDE.md
- docs/fix-history.md
- tests/unit/claude-md-split.test.js
- .claude/commands/sync-docs.md

CHANGES:

Extraction | CLAUDE.md | Condensed the five largest bullets. Inbound capture
  17.5 -> 12.8 KB (dropped the R11-N internal-transfer chronology and the F1b
  brand-prefix discovery archaeology, both already in fix-history); role model
  (the R-3 / R8-4 missed-widening incident parentheticals -> one sentence naming
  the recurring defect); Neon write discipline (the P-1 / F2 incident stories ->
  their rules, plus removal of a "future lever" that had SINCE SHIPPED as the
  deferred mirror -- a stale entry, not just narrative); System Health (three
  sections of implementation detail already documented at their own operator
  items); deferred Neon mirror (the tail-scan algorithm -> its three
  preserve-these properties). Also condensed the B-2 paragraph added to the
  read-back bullet earlier this session -- same pattern, same treatment.
  The 3 smaller bullets (coercion / direct metrics / read-back) were left
  substantially intact: on close reading they are rule, not padding.

Suggestion 1 | docs/fix-history.md | Added the Round-14 family (S2-0, B-1, B-2,
  S2-2) so this session's own commits don't create the drift the pass cleans up.
  Verified first that every fix code cited by the top 8 bullets ALREADY had a
  fix-history entry -- which is what made this deletion-of-duplicate rather than
  relocation, and is the single fact that made the edit low-risk.

Suggestion 2 | tests/unit/claude-md-split.test.js | Per-bullet RATCHET. New
  Common Gotchas bullets must be under 4 KB; the five already over are
  grandfathered at measured size and may only SHRINK. Rationale in the test:
  the 200 KB cap is a cliff that fires on whoever adds the last paragraph
  rather than whoever grew a bullet over weeks. Negative-tested BOTH directions
  (growing a grandfathered bullet fails test 7; removing an allowlist entry
  fails test 6). Seeds measured at the CLOSE of the pass, with a comment
  recording why that distinction earned itself.

Suggestion 3 | .claude/commands/sync-docs.md | New CHECK 5 (doc weight). Reports
  size vs budget and headroom, finds the largest bullets, identifies narrative
  belonging in fix-history (with the "does a developer need this in context, or
  does it explain how we learned it?" test), flags rules now enforced by a test,
  and flags entries describing shipped work as planned. Carries an explicit
  counter-instruction -- do NOT propose deleting a rule, and verify every
  dropped reference still resolves before proposing any removal -- because this
  check's failure mode is the opposite of the other four's. Adds a DOC WEIGHT
  block to the report format; "four checks" -> "five checks".

Suggestion 4 | CLAUDE.md | A "how to write one" note at the top of Common
  Gotchas, carrying the measured evidence (372 -> 150 -> 178 KB; ~77% of
  regrowth from existing bullets) and three habits: one bullet = one RULE + the
  trap, incident to fix-history; write the bullet ONCE at the END of a phased
  rollout (amending per phase produced the biggest ones -- the sub-queue work
  added ~12 KB across six commits); a rule enforced by a test needs one line
  naming the test.

TEST RESULTS: PASSED -- npm run ci 612/612 (+2 new), INV-16 guard clean,
F8 split guard (7 tests) green. No code files were touched, so ci:ui is not
implicated.

REGRESSION RISKS:
- The real risk in this edit is not a broken build but quietly deleting a
  load-bearing sentence. Mitigated by a scratch token-loss checker
  (scratchpad/checkloss.py) run per-bullet AND whole-file against HEAD: it
  extracts every fix code, INV-/S-/Operator-State reference, backticked
  identifier and Script Property from the BEFORE text and asserts each dropped
  one still resolves somewhere in the live doc set. It caught three genuine
  losses -- REPORT_USAGE_SCAN_CAP_, ncMissingTableError_, clChainHtml_ (and
  minDate) -- all restored as compact pointers. Final whole-file run is clean
  apart from the literal word "ASSERTED", a prose emphasis my regex read as a
  constant.
- The ratchet will fail CI for anyone legitimately growing one of the five
  grandfathered bullets. That is the intent, and the message says what to do.
  It fired on its own author during this pass; the resolution (re-seed from a
  finished state) is recorded in the test comment so the next person doesn't
  shave unrelated prose to satisfy a stale snapshot.
- /sync-docs behavior changes for future runs only; no runtime impact.

NET SCORE: 0 production fixes - 0 new failure modes = 0
  Deliberately zero: this is a documentation-and-process change, not a bug fix.
  Counting it otherwise would inflate the tally the reflect step exists to keep
  honest. Its value is preventive and shows up as bugs that don't happen.

INVARIANTS AT RISK: None. No code changed. INV-16 guard clean; the F8 split
  guard (index <-> file parity for invariants / scenarios / operator items)
  passes, so no index line lost its entry or vice versa. Every INV- reference
  in CLAUDE.md survived the edit (55 before, 55 after).

OPERATOR ACTIONS / DEPLOY:
- None. No Apps Script source changed; nothing to push to a project.
Deploy: N/A -- documentation and test-harness only.

FOLLOW-ON ITEMS:
- The 3 remaining top-8 bullets (comma-joined coercion 3.8 KB, direct-extension
  metrics 4.8 KB, Neon read-back 5.6 KB) were assessed and left: they are
  substantially rule. The coercion one in particular is the most
  safety-critical gotcha in the file and was deliberately not touched.
- Key Design Decisions (40.4 KB, 23% of the file) got no extraction pass. It is
  the obvious next target and has the same shape.
- Growth rate remains the thing to watch: 178.1 -> 171.7 KB buys ~1.5 weeks at
  the observed ~4 KB/day. The ratchet is what makes that rate visible per
  commit rather than at the cliff.
- Still open from the audit: S2-1, B-3, B-5, B-6, and the dead-code list
  (escRowDepartment_, yesterdayIso_, typeOfCell_, pullReportData, plus five
  `_`-suffixed diagnostics wanting Run-picker wrappers).

DOCUMENTATION UPDATES NEEDED: None outstanding -- this session WAS the
  documentation update. The four gaps flagged by the previous /sync-docs run
  (queue-split bullets, INV-30, Operator State #42, the plan doc) were closed in
  commit 6fec21a.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
