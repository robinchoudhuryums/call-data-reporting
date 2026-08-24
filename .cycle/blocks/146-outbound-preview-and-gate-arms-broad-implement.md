---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- IT-4 | `previewOutboundAssistLinks` -- the read-only validation run the Step 4 outbound match
  shipped without. Drives the REAL record builder, so it cannot drift from production.
- IT-5 | The outbound drill's entitlement gate implemented only ONE of getCallJourney's two
  authorization arms, so it FALSELY REFUSED legitimate managers. That is what made the
  `not-entitled` path reachable from the UI. Now mirrors both arms in the same order.

Files modified:
- apps-script/cdr-import/inboundCalls.js               (previewOutboundAssistLinks + wrapper)
- apps-script/cdr-import/CDR Tools.js                  (menu item)
- apps-script/department-dashboard/InboundReport.gs    (two-arm gate)
- tests/unit/inbound-calls.test.js                     (+1 preview test; Logger stub does %s)
- tests/unit/heatmap-cell-drill.test.js                (+1 regression pin; doubles updated)
- docs/known-issues.md                                 (both, under the Step 4 owner ruling)

CHANGES:

IT-5 | InboundReport.gs | THE ACTUAL DEFECT, and it is the inverse of what the previous block
recorded as a follow-on. That block said the `not-entitled` path was "unreachable from the UI
(the button only renders on a record the viewer could already drill)". That reasoning was
wrong, because "could already drill" has TWO arms in getCallJourney: the dept-scoped predicate
query, and only if that misses, the F-4 `callIdInDeptMissedReport_` fallback. The outbound gate
implemented the fallback ONLY. So a manager who reached the assist record through the PREDICATE
arm -- its entry_queue is in their dept -- and whose id is not an abandoned parent in their
Missed report was REFUSED a call they had just been shown a link for. A sub-60s abandon is the
concrete case: DQE emits no queue sentinel for it, so it never appears in the Missed report,
yet the record is perfectly reachable by entry_queue. The gate now runs the predicate-scoped
link query FIRST and falls back to F-4, in the same order as the inbound drill, so the outbound
call is reachable exactly when the record linking to it is. The security property is unchanged
in the other direction: still a link + a dept proof, and no link still means no access.

IT-4 | inboundCalls.js + CDR Tools.js | `previewOutboundAssistLinks(dateIso)` -- read-only,
sheet-only (runs during a Neon outage), menu-wired beside the existing transfer previews. It
does NOT re-implement the matching rule: it runs the real `buildInboundCallRecords_` over a
Call_Legs sheet and reports the link state of every internal assist record -- OUTBOUND-linked,
inbound-linked, or unlinked -- naming the requester and the linked call id so a line can be
spot-checked against the raw legs. That design choice is the direct lesson of this thread: the
chain diagnostic's hand-written 1-hop rule is exactly what produced a temporally impossible
"resolution", and a preview that can disagree with production is worse than none. Unlinked
records are reported, not hidden: they are the unique-match rule declining to guess, and the
receiving queue still gets its own drill.

Tests | +2 (902 -> 904). heatmap-cell-drill: a REGRESSION PIN that the predicate arm entitles
ALONE and does not consult the F-4 fallback (the false-refusal case); the existing doubles
encoded the single-arm behavior and were updated as part of the fix, with the fake now telling
the scoped and unscoped link queries apart. inbound-calls: the preview names the linked call,
the requester, and the unlinked residue, and its tally matches. Harness note: the Logger stub
now performs %s substitution -- joining arguments instead would have let a malformed format
string pass unnoticed, which is how the summary line first "passed" while rendering wrong.

TEST RESULTS: PASSED -- 904/904 (was 902; +2). `npm run ci:ui` FULL GATE PASSED. INV-16 guard
green; CLAUDE.md split/ratchet guards green; node --check clean on both edited files.

REGRESSION RISKS:
- The gate now issues up to TWO link queries instead of one (the second only when the first
  misses). Both are bound-parameter lookups on the (call_date, call_id) index path; admins
  still issue none. Cost is negligible against the outbound fetch that follows.
- The change only ever WIDENS access from the previous commit's state -- and only to the set
  the inbound drill already allows for the linking record. It cannot widen beyond that: the
  link requirement and the is_internal / kind filters are untouched.
- The preview calls the real builder on a whole day's legs. That is the same work the import
  does, so it is bounded by a normal import's cost; it writes nothing and holds no connection.

INVARIANTS AT RISK: None. INV-01 clean (the preview is editor-run in cdr-import and writes
nothing; the gate is read-only). No cache version moves -- getCallJourney stays uncached.

NET SCORE: 1 - 0 = +1
  (IT-5 is a real defect that would have refused legitimate managers the moment Step 4 reached
  production, on precisely the sub-60s assists that are the most common shape. It had not yet
  fired only because the feature is undeployed.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (the preview) and the dashboard (the gate fix). | BLOCKS DEPLOY: N
- RUN THE PREVIEW before trusting the link at volume: CDR Tools -> "Preview outbound assist
  links (pick date)…", or `previewOutboundAssistLinks('2026-08-21')` from the editor. No Neon
  needed, so it works during the outage. Two dates is better than one. Bring me the tally --
  an OUTBOUND-linked line whose requester was NOT on that call at the assist time is the
  failure this instrument exists to catch. | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`;
Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- The journey drill is still not exercised by `npm run ci:ui` at all (getCallJourney is unmocked
  in the harness, so no driver clicks a "↳ path" button). Both the outbound render and the
  not-entitled copy are therefore unit-pinned but never rendered under the gate. Worth adding a
  fixture + driver visit; out of scope here.
- Sub-60s internal abandons still have no entry point of their own (they are reachable only
  via a heatmap cell drill or the Inbound report, not the Missed report); owner ruling.
- Unchanged ledger: Outbound release runbook, the backfills before ~Sep 4, coaching arming,
  #49's one-time re-export, the egress "top:" ranking read.

DOCUMENTATION UPDATES NEEDED:
- Applied: docs/known-issues.md's Step 4 owner-ruling entry gains the two-arm gate correction
  (with the sub-60s example) and names the validation instrument. CLAUDE.md needed no change --
  its Step 4 sentence already points at that entry for the full ruling.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
