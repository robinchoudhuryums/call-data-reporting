---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- IT-1 | Internal transfer-abandons had no reachable path drill for the RECEIVING dept. The
  Round-16 rule dropped every uniquely-matched internal group, so the DQE-rendered "↳ path"
  button on those abandons resolved to `not-captured` — the better the R11-N matcher worked,
  the more reliably that dept's drill failed. Owner ruling: write the record, link it, and
  prefix the reconstructed origin hop.

Files modified:
- apps-script/cdr-import/inboundCalls.js                  (capture: keep + enrich the record)
- apps-script/department-dashboard/script-10-escalations.html (journey row: "before transfer")
- tests/unit/inbound-calls.test.js                        (test double updated + 2 new tests)
- CLAUDE.md                                               (R11-N bullet + journey-drill bullet)

CHANGES:

IT-1 | inboundCalls.js | Two edits to `buildInboundCallRecords_`:
(a) the R11-N enrichment pass now records WHAT matched, not merely THAT it did —
`enrichedRoots[root]` becomes `{callerRoot, agentExt, agentName, originQueue, originStart,
answerT, answerTalk}`, sourced from the matched `agentBusy` entry (which now also carries the
agent's CALLEE_NAME) and the caller's own record;
(b) the `internalPending` merge no longer drops matched groups. A matched group is written
with `relatedCallId = callerRoot` and its journey PREFIXED with two reconstructed events —
`{kind:'queue', name:<origin queue>}` and `{kind:'answer', name:<agent>, talk:<real secs>}`,
both flagged `transfer:true, origin:true` — then re-capped at IC_JOURNEY_MAX_EVENTS. The
unmatched branch keeps the Round-16b context-match behavior verbatim.

WHY THIS REVERSES ROUND-16: that rule called the standalone record a "double-tell". It was
right about the duplication and wrong about the audience. The caller's journey belongs to the
ORIGIN dept (CSR: answered → transferred out → abandoned); the abandon itself lands in the
RECEIVING dept's numbers, and their Missed report renders a path button off the DQE queue-only
sentinel — which has NO internal/external distinction, only `abandoned && waitSec > 60`. With
the record dropped, that button had nothing to resolve. Owner's 2026-08-21 preview run: 11
candidates, 10 uniquely matched, 0 ambiguous, 1 chained; 6 of the 11 clear the DQE 60s
threshold, i.e. 6 path buttons a day that could not work.

Metric-safe by construction, unchanged: `is_internal` is excluded at ~10 query sites and
`getCallJourney` remains the sole consumer that does not exclude it. Ambiguous and unmatched
groups still get NO fabricated origin — the unique-match-only contract is untouched.

Client | script-10-escalations.html | `clJourneyRowHtml_` appends a "before transfer" bit for
`ev.origin`, so reconstructed events do not read as literal legs of the call being drilled.
Additive and inert for every existing event (none carry `origin`). The existing `cj-related`
block already renders the back-link, so no other client change was needed.

Tests | inbound-calls.test.js | The existing R11-N test asserted `recs.length === 1` — the
dropped-record behavior this change reverses — and was updated as part of the fix (not
reactively). Two new tests: the matched group is written, `isInternal`, linked, with the
journey reading `queue:A_Q_CSR → answer:Raymond (Ray) Mathews (talk 295s) → queue:A_Q_Spanish`,
provenance flags on the first two and NOT the third; and an AMBIGUOUS group is still written
but with no fabricated origin and a null link.

TEST RESULTS: PASSED — 888/888 (was 886). `npm run ci:ui` FULL GATE PASSED (client fragment
changed). INV-16 guard green. node --check clean on the edited .js.

REGRESSION RISKS:
- More rows in `inbound_calls` (a handful per day). Date handling is unchanged: records are
  dated from their own first leg and the P-1 stray-date guard already drops anything outside
  `expectedDateIso`, so the authoritative per-date DELETE is unaffected.
- The prefixed events are SYNTHESIZED from a cross-referenced call. Mitigated three ways:
  unique-match-only (never guesses), provenance flags on the events, and the rendered "before
  transfer" disclosure. Same synthesis R11-N already performs in the other direction.
- Journeys at the event cap lose their tail to the prefix (slice after concat). Bounded and
  rare; the abandon itself is in the prefix's own group so it survives.

INVARIANTS AT RISK: None. The journey-only contract holds (no disposition/count/queue field is
written by this path); INV-01 untouched (capture-side, cdr-import); no cache version affected
(getCallJourney is uncached by design).

NET SCORE: 1 − 0 = +1
  (A daily-volume drill that silently failed for the receiving dept now works; no new failure
  mode identified beyond the bounded synthesis risks above, each disclosed.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (capture) AND the dashboard (the journey-row disclosure). | BLOCKS
  DEPLOY: N
- Takes effect for dates imported AFTER deploy. To gain records for already-imported dates,
  run `backfillInboundCalls` for the surviving `Call_Legs_*` window once Neon is reachable —
  another reason not to let that ~14-day window slide. | BLOCKS DEPLOY: N
- Verification (needs Neon up): open the RECEIVING dept's Missed report for a date with a
  known transfer-abandon (e.g. Sales MWC, 2026-08-21, call 1783983050778) and click "↳ path".
  Expect: "internal call" tag, chain reading CSR → agent → Sales MWC, the first two rows
  marked "before transfer", and a working "view that call's path" link. | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`;
Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- CHAINED transfers (1 of 11 in the owner's sample, ~9%): when the agent's own inbound arrived
  via an internal transfer, there is no directly-captured source call and the matcher reports
  "needs hop-following". `previewInternalTransferChains` exists to scope it. Separate effort —
  it requires following N hops rather than one, and the unique-match discipline has to hold at
  every hop.
- Sub-60s transfer-abandons (4 of 11) now have records but no entry point: DQE's sentinel
  threshold excludes them, so no path button is rendered anywhere. Only worth surfacing if the
  owner wants a dedicated internal-transfer list.
- Unchanged ledger: Outbound release runbook, the 08/20 backfills, coaching arming, the
  #49 export-trigger one-time re-export, the egress "top:" ranking read.

DOCUMENTATION UPDATES NEEDED:
- Applied in this change: CLAUDE.md's R11-N bullet (the Round-17 reversal, with the mechanism
  and the measured numbers) and the per-call journey-drill bullet. Nothing else.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
