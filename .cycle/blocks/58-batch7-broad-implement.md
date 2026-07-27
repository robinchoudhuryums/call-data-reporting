---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Batch 7 / **F8 — CLAUDE.md was ~372 KB and is injected into EVERY session's context.** Split into a working document + four indexed reference files, and guarded so it cannot silently regrow or drift.

**373,570 → 153,222 bytes (−59%).** Zero content lost: every moved line is verbatim in its new home (verified line-by-line against `git show HEAD:CLAUDE.md` — 3 lines differ, all three the Read-first prose I deliberately rewrote).

Files modified:
- CLAUDE.md (four sections replaced by indices + pointers; Read first restructured)
- docs/invariants.md (NEW — the Invariant Library in full, 97 KB)
- docs/operator-state.md (NEW — the 38 numbered items in full, 51 KB)
- docs/regression-scenarios.md (NEW — S1…S40 with steps, 43 KB)
- docs/client-ui-conventions.md (NEW — the client/presentation gotchas, 55 KB)
- tests/unit/claude-md-split.test.js (NEW — the index↔file drift guard + size cap)
- tests/unit/cache-version-sync.test.js (DOC_FILES widened — see below, this one mattered)
- docs/architecture.md, docs/conventions.md, docs/fix-history.md, README.md, tests/README.md (pointers that named CLAUDE.md as the canonical home of moved content)

CHANGES:
F8 | CLAUDE.md → docs/invariants.md | The Invariant Library (96 KB, 26% of the file) moved out verbatim. CLAUDE.md keeps `### Invariant Library` with a **hand-written one-line summary per INV** (not a truncation — a truncated INV-30 or INV-55 is worse than useless), each carrying its Subsystem so the index stays greppable the way the full list was. Header states the entry is authoritative and the index is a finding aid.
F8 | CLAUDE.md → docs/regression-scenarios.md | S1…S40 (42 KB) moved out; the index is the `S# | title | Subsystem:` lines verbatim, so a scenario is chosen from CLAUDE.md and walked from the doc.
F8 | CLAUDE.md → docs/operator-state.md | The 38 numbered items (50 KB) moved out. **The scope note and the "start at the Health page" instruction stayed in CLAUDE.md** — they are rules about how to use the checklist, not checklist content, and an agent needs them unprompted. Index is one line per item. The doc's header says the numbering is stable because items are cited BY NUMBER across the repo ("Operator State #38"), so retire in place rather than renumber.
F8 | CLAUDE.md → docs/client-ui-conventions.md | 14 Common Gotchas bullets (53 KB) that describe **how a surface is built** rather than a trap that bites unrelated work: the Insights consolidation + period slider + density + saved views, the tour, the A/B remote, the anti-intimidation layer, client prefs, the design tokens, the `ds-*` layer, Pass-2, report SWR, and the two Overview bullets. **The client traps that CAN bite you without warning deliberately STAYED in CLAUDE.md** and are not duplicated: `safeChart_`, `dsConfirm_`, `csvSafeCell_`, the datalabels registration, the OKLCH/datalabels fillStyle rule, and the `</script>`-in-scriptlet escape. The index bullet says so explicitly, in both directions.
F8 | tests/unit/cache-version-sync.test.js | **The split would have silently gutted this guard.** Its `DOC_FILES` was a hardcoded four-file list, and INV-30 — the cache-version table, the densest source of `prefix:vN` claims in the repo — moved into `docs/invariants.md`, which was not on it. Added the four new files. Kept the list EXPLICIT rather than globbing `docs/*.md`: I tested a glob and it fails on 10 legitimate historical references in `fix-history.md` + `insights-drilldown-spec.md`, which are archives. Comment now says why, and that any future section moving out of CLAUDE.md with a current version claim must be added.
F8 | tests/unit/claude-md-split.test.js | The guard for the split's OWN new failure mode (see REGRESSION RISKS). Five checks: (1) CLAUDE.md links all four files AND links them from "Read first" specifically — the nav entry point a fresh session uses; (2) invariant IDs + Subsystems match between index and doc; (3) scenario IDs + titles + Subsystems match exactly; (4) operator item numbers match and stay contiguous from 1; (5) **a 200 KB size cap on CLAUDE.md** whose failure message names the split pattern as the remedy rather than raising the number.
F8 | docs/architecture.md, docs/conventions.md, docs/fix-history.md, README.md, tests/README.md | Repointed the statements the split made WRONG — not merely imprecise. Two claimed canonicality that had moved: "CLAUDE.md INV-30 is the canonical current-version list" (conventions.md) and "CLAUDE.md INV-30 is canonical and reflects current code" (architecture.md) — a reader following those now lands on a one-line summary and believes it is the full contract. Also `fix-history.md`'s live-truth/archive division (its whole premise) now names the four split files as still-live-truth, and its taxonomy table's INV row points at the doc. README gains one paragraph explaining that "see CLAUDE.md INV-54" means index-there, entry-in-the-doc.

TEST RESULTS: passed. `npm run ci` → **505/505** (was 500; +5), INV-16 guard clean, cache-version-sync clean.
**Every new guard was verified to actually catch its drift class** — I broke each one and confirmed the failure before restoring: an INV added to the doc but not the index (caught, names INV-56), a scenario title edited in the index only (caught, prints both strings), a "Read first" pointer removed (caught), CLAUDE.md padded past the cap (caught, reports 209 KB), and a stale `summary:v14` in `docs/invariants.md` (caught — proving the widened DOC_FILES restored the coverage the split would have lost). One real bug surfaced this way: my `section()` helper cut a `##` section off at its first `###` sub-heading, so the Read-first check failed as soon as I restructured that section into subsections; fixed to stop only at a heading of the same level or shallower.
Regression Scenarios: NOT EXECUTED — no `apps-script/` file was touched, so no scenario's Subsystem overlaps a change. Documentation and test-harness only.

REGRESSION RISKS:
- **The split's own new failure mode is index drift**, and it is silent in the worst direction: a new invariant added only to `docs/invariants.md` is invisible to anyone reading CLAUDE.md. That is precisely why the guard above ships in the same change rather than as a follow-on.
- **`/setup-cycle` would undo this.** It REWRITES `### Invariant Library` / `### Regression Scenarios` with full bodies. If re-run, the ID/subsystem checks would still pass (the bodies would agree with the docs) — the **size cap is the backstop** that catches it (152 KB + 96 KB + 42 KB is well over 200 KB). Worth knowing before anyone re-runs it.
- **Commands still resolve.** Every `/cycle-*` and `/broad-*` instruction that reads "CLAUDE.md's Cycle Workflow Config → Invariant Library / Regression Scenarios" still finds a section by that exact name; only the body is now a pointer + index. I deliberately kept all four headings rather than deleting them for this reason. Pre-existing imprecision left alone: `/broad-implement` §4 says the invariant library is "listed in CLAUDE.md Common Gotchas" — it never was, it is under Cycle Workflow Config.
- **~25 KB of net new bytes across the repo** (the indices + provenance headers) in exchange for 220 KB out of every session's context. Stated plainly because it is a real duplication: 55 invariant summaries and 40 scenario titles now exist in two places, which is exactly what the new guard exists to police.
- **Judgement risk, named:** which 14 gotcha bullets are "how a surface is built" vs "a trap" is my call, not a mechanical rule. I resolved it conservatively — the six client traps stayed, and four mixed server+client bullets (per-row WoW chips, missed-card tiers, threshold drift, the heatmap) stayed too because they describe payload fields as well as rendering. If a client rule turns out to be missed in CLAUDE.md, the fix is to copy that ONE rule back, not to unwind the split.
- No `apps-script/` file, cache key, payload shape, auth gate, or runtime behavior was touched.

INVARIANTS AT RISK: None — but two guards needed active repair to STAY effective, which is the interesting part.
- INV-30 — the cache-version guard would have gone blind on the moved table. Fixed in the same commit and verified by deliberately introducing a stale version.
- INV-16 — no duplicated file touched; guard clean.
- INV-01 / INV-55 — no code touched.
- INV-22 — the frozen `dqe-report` subsystem was not touched.

NET SCORE: 0 − 0 = 0
- Honest score for a documentation batch, and deliberately not inflated. Under /reflect's three-way tally these are structural: one restructure + two guards (one new, one repaired).
- **The one thing here that would have fired:** widening `cache-version-sync`'s DOC_FILES. Not a pre-existing bug — a bug this batch would have INTRODUCED, catching itself. Had I moved INV-30 without it, the guard would have passed while policing nothing, and the next cache bump could have shipped with the canonical table a version behind. That is the exact class of drift the guard was written for.
- Value is future-tense: the file is now readable in one sitting, and it cannot regrow to 372 KB without a test failing.

OPERATOR ACTIONS / DEPLOY:
- None. No `apps-script/` file changed; nothing to deploy, no Script Property, no migration.
- Worth knowing (not an action): if you ever re-run `/setup-cycle`, expect it to re-inline the Invariant Library and Regression Scenarios into CLAUDE.md and trip the size cap. Re-split rather than raising the cap.
Deploy: N/A — documentation + tests only. All prior increments' deploys (53 CDR Import + Department Dashboard, 56, 57) are still pending and unaffected by this batch.

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- **Common Gotchas is still the largest section at ~87 KB / 50 bullets** — CLAUDE.md is readable now but not small. The remaining reduction is a different, higher-risk job: separating each bullet's RULE from its version history, which means paraphrasing live rules, and a paraphrase that drops a caveat is how this repo gets bitten. That should be done bullet-by-bullet with review, never in one pass. Explicitly NOT attempted here.
- The four biggest remaining bullets are the Inbound capture (13 KB), Neon write discipline (5.8 KB), the role model (5.5 KB), and Neon read-back (5.0 KB). Each is genuinely load-bearing; each is also mostly history.
- `docs/known-issues.md` has no entry for either guard class hardened this cycle (Batch 6's false-clean compare gate, and this batch's index-drift). Both are institutional-memory items now.
- `/broad-implement`'s §4 wording ("invariant library, listed in CLAUDE.md Common Gotchas") is wrong about the location and always was — it is a template file, so fixing it belongs in a `/sync-commands` pass, not here.
- `docs/invariants.md`'s INV-53 says "See the 'INV-53 expansion to IR/PR/CR' Common Gotchas bullet" — that bullet is actually under Key Design Decisions. Pre-existing, unrelated to the split, left alone.

DOCUMENTATION UPDATES NEEDED: None outstanding — this batch WAS the documentation change, and its downstream pointers were swept in the same commit (architecture.md, conventions.md, fix-history.md, README.md, tests/README.md). Noted for a future `/sync-docs`: the two guard classes above deserve `docs/known-issues.md` entries, and `docs/fix-history.md` has no Round-13 `F8` entry describing the split itself.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
