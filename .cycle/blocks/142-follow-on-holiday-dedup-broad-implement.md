---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- FO-1 | The client-side company-holiday range test had FOUR inline copies (script-1-core,
  -2-chrome, -6-ir, -11-qcd-boot) and they had already DRIFTED: script-6-ir guarded malformed
  range entries, the other three did not. Consolidated onto one shared helper, keeping the
  strongest behavior, with a tripwire against a fifth copy.

Findings NOT implemented (blocked, with the specific unblock named):
- FO-2 | CHAINED internal transfers (~9% of candidates) -- BLOCKED ON MEASUREMENT, not effort.
- FO-3..FO-7 | Sub-60s transfer entry point, inbound-report-lite fallback, Direct dal-cutover,
  further Neon fallbacks, egress reduction levers -- all owner-gated rulings or blocked on
  data that does not exist yet.

Files modified:
- apps-script/department-dashboard/script-1-core.html      (shared helper hardened + docstring)
- apps-script/department-dashboard/script-2-chrome.html    (inline copy -> shared helper)
- apps-script/department-dashboard/script-6-ir.html        (inline copy -> shared helper)
- apps-script/department-dashboard/script-11-qcd-boot.html (inline copy -> shared helper)
- tests/unit/cross-file-pins.test.js                       (+1 tripwire)

CHANGES:

FO-1 | four client fragments + cross-file-pins | `isCompanyHolidayIso_` (added to
script-1-core during the freshness-credit work) is now the SINGLE client reader of
`window.__COMPANY_HOLIDAYS__`. The three other fragments' inline `isHoliday` / `isHol`
closures are deleted and their call sites call the helper: `workingDaysBetween_`
(script-2-chrome, the INV-35 length-mismatch math), the INV-28 prior-window computation
(script-6-ir), and `prevWorkdayIso_` (script-11-qcd-boot). The consolidation adopts the
MALFORMED-ENTRY GUARD (`r && r.from && r.to`) that only script-6-ir carried -- a
consolidation must keep the strongest behavior, never the weakest. The fragments keep their
prose comments naming the global; only the code paths are shared. Safe because script.html
splices every script-N fragment into ONE IIFE (pinned by html-include-structure) and function
declarations hoist within it, so call order is irrelevant.

Enforcement (the C2 rule -- "what enforces this?" answered in the same commit): a new
cross-file-pins test asserts exactly one fragment performs a property ACCESS on the global
(regex `\.\s*__COMPANY_HOLIDAYS__`, so the surviving prose mentions do not trip it) and that
the shared helper still carries the guard. Nothing behavioral could catch a fifth copy -- each
copy renders perfectly and is only WRONG on a holiday, which is exactly how these four drifted
unnoticed.

FO-2 (NOT BUILT -- deliberate) | The chained case is where the transferring agent's OWN inbound
arrived via an internal transfer, so no captured inbound exists for their extension. Hop-
following is the obvious remedy and I did not build it, because `previewInternalTransferChains`
turns out to be a NEIGHBORHOOD-SCAN diagnostic, not a resolver: it classifies each chain case
as one-hop / two-hop / internal-origin / via-queue / NO-SOURCE and tallies them. That taxonomy
is decisive -- a two-hop case is fixable by transitive matching, while a `no-source` case
(nothing in the day's sheet rang that extension) cannot be fixed by hop-following at ANY depth.
The owner's run produced ONE chained case and the paths diagnostic does not say which shape it
is. Building a multi-hop resolver against one unclassified sample, with Neon down so nothing
can be validated end to end, would be guessing at the mechanism -- the same measure-first
discipline that scoped R11-N itself ("the read-only diagnostic settled these before this
shipped") and that closed the row-34 question. UNBLOCK: run `previewInternalTransferChains()`
(cdr-import editor, CDR Tools; reads Call_Legs_* sheets only, so it works during the Neon
outage) and bring the tally.

TEST RESULTS: PASSED -- 889/889 (was 888; +1). `npm run ci:ui` FULL GATE PASSED (164 checks,
all stages) -- required and load-bearing here: the unit suite's assembled-body `node --check`
proves the IIFE PARSES but cannot prove a cross-fragment identifier RESOLVES, and the gate
exercises all three touched paths (heatmap caption working-days, the IR prior window, the QCD
boot's previous-workday). INV-16 guard green; CLAUDE.md guards green.

REGRESSION RISKS:
- Behavior is intentionally CHANGED in one direction: the three previously-unguarded copies now
  tolerate a malformed holiday range instead of comparing against `undefined`. Strictly more
  defensive; a well-formed list (what the server emits) is byte-identical.
- The helper re-reads `window.__COMPANY_HOLIDAYS__` per call where the inline copies hoisted it
  outside their loop. A property read per day over windows of tens of days -- immeasurable.
- No interface, return type, or default changed; all three call sites pass the same ISO string
  and consume the same boolean.

INVARIANTS AT RISK: None. INV-35 (the 1.2x length-mismatch flag counted in working days) and
INV-28 (the working-day prior window) both depend on this predicate and are unchanged for
well-formed input -- that equivalence is the point of the consolidation.

NET SCORE: 0 - 0 = +0
  (Code health: no user-visible bug existed this month -- the drift was benign because the
  server emits well-formed ranges. What it removes is the recurrence surface, and the tripwire
  is what makes that durable.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard. No configuration, migration, or one-time step. | BLOCKS DEPLOY: N
- To unblock FO-2, run `previewInternalTransferChains()` from the cdr-import editor (CDR Tools
  menu) and share the tally -- it needs no Neon, so it is runnable during the outage. | BLOCKS
  DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- FO-2 chained transfers -- as above; blocked on the chains tally, not on effort.
- Sub-60s internal transfer-abandons have records but no entry point (DQE's sentinel threshold
  excludes them). Needs an owner ruling on whether a dedicated internal-transfer list is wanted.
- Egress reduction levers (payload slimming, SQL rollups): EA-1 attribution shipped only
  yesterday AND Neon is down, so the ranking has essentially no data. Read it after a week of
  normal traffic; the whole point was to pick the lever from evidence.
- Inbound-report-lite fallback / Direct dal-cutover / further Neon fallbacks: owner-gated.
- Noticed, out of scope: the SERVER has its own holiday helpers (`getCompanyHolidayRanges_` /
  `isCompanyHoliday_`, Util.gs) that this client helper deliberately mirrors. That is a
  legitimate client/server pair, not a fourth copy -- but nothing pins the two to the same
  semantics. Not a bug today; a candidate tripwire if the ranges format ever changes.

DOCUMENTATION UPDATES NEEDED:
- None. The helper's own docstring carries the consolidation story and names the tripwire;
  CLAUDE.md has no bullet describing the old per-fragment copies.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
