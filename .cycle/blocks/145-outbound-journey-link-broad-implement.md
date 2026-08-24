---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- IT-3 (Step 4, OPTION A per owner ruling) | An internal assist request placed during the
  requester's OUTBOUND call is now linked to that call, and the receiving dept's path drill can
  follow the link -- the first surface where one dept sees another dept's customer call.
  Authorization is a SERVER-RE-DERIVED capability, not a client claim.

Files modified:
- apps-script/cdr-import/inboundCalls.js              (outboundBusy index, link + kind, DDL/upsert)
- apps-script/department-dashboard/InboundReport.gs   (kind param, getOutboundCallJourney_ + gate)
- apps-script/department-dashboard/CallerLookup.gs    (shaper exposes kind/origin fields)
- apps-script/department-dashboard/script-5-dept.html (kind plumbed, outbound renderer, refusal copy)
- tests/unit/inbound-calls.test.js                    (+4 capture tests)
- tests/unit/heatmap-cell-drill.test.js               (+6 entitlement tests; CallerLookup.gs loaded)
- CLAUDE.md, docs/known-issues.md                     (the owner ruling, recorded in full)

CHANGES:

IT-3 CAPTURE | inboundCalls.js | New `outboundBusy` index built with the SAME group shape
outboundCalls.js uses (no Incoming leg + an Answered Outgoing leg to an external number), so the
two captures cannot disagree about what an outbound call is. In the internalPending merge, when
no concurrent captured INBOUND matched, the requester's concurrent OUTBOUND group is tried --
unique-match only, same +/-5s overlap rule; 0 or >1 leaves the record unlinked rather than
guessing. An inbound match ALWAYS wins (a handed-over customer is a stronger relationship than
mere co-presence). New `related_call_kind` column ('inbound' | 'outbound') says which table
`related_call_id` points at; NULL reads as 'inbound' because every pre-Step-4 row linked an
inbound call, so the read side COALESCEs rather than treating NULL as unknown.

IT-3 READ | InboundReport.gs | `getCallJourney` takes `kind` (validated; unknown values throw)
and routes 'outbound' to the new `getOutboundCallJourney_`. THE GATE, which is the whole point:
a manager reaches outbound call O only when (1) some inbound_calls row R has
`related_call_id = O` AND `related_call_kind='outbound'` AND `is_internal = TRUE`, and (2) R
itself passes the UNCHANGED F-4 gate on the manager's own dept (`callIdInDeptMissedReport_`).
The link is looked up SERVER-side on the viewer's dept; the client never asserts entitlement.
Reachable set = "outbound calls a queue in my dept was asked to help with", nothing wider.
Admins skip the derivation (already entitled to every dept). Fails CLOSED; a refusal returns
`reason:'not-entitled'` with NO payload. Ids are bound parameters, never inlined.

IT-3 CLIENT | script-5-dept.html | The related-call button carries `data-cj-kind`; the delegated
handler and `callJourneyShow_` pass it through. Wording switches to "on an active OUTBOUND
call" for outbound links -- with the Step-3 "Internal request from ..." line directly above it,
inbound wording there would read as a contradiction. New `outboundJourneyHtml_` reuses
`clChainHtml_` / `clJourneyRowHtml_` verbatim (outbound records are built by the same
`icBuildJourney_`, so the event shape is identical) with its own header: an outbound call has an
agent and a connected/talk outcome, not a disposition or queue path. A dedicated `not-entitled`
message says plainly that the linked call belongs to another department, rather than implying
missing data.

DISCLOSURE | Deliberately bounded: `callee_hash` and the write timestamp are dropped by
`callerLookupShapeOutbound_`, and phone-shaped callee names were masked at capture, so no caller
identity crosses the boundary -- only the other dept's agent name, org label, outcome and masked
journey. Pinned by a test asserting a sentinel hash value never appears in the response.

Tests | +10 (892 -> 902). Capture (4): links to the concurrent outbound call with
kind='outbound'; an inbound match wins over a concurrent outbound one; two concurrent outbound
calls leave it unlinked; a non-overlapping outbound call is not linked. Entitlement (6): a
manager whose dept owns a linking assist CAN drill (and the gate is called with the LINKING
record id, scoped to their dept); a manager whose gate refuses gets `not-entitled` and no
payload; an outbound call NOTHING links to is refused even with a permissive gate (the link IS
the capability); the link SQL binds its ids and filters on both kind and is_internal; an admin
skips the derivation; an unknown kind throws. Harness note: CallerLookup.gs joined that suite's
load -- it supplies the shapers getCallJourney calls across Apps Script's shared global scope,
and their absence made the first run fail closed exactly as production would if the file were
missing.

TEST RESULTS: PASSED -- 902/902 (was 892; +10). `npm run ci:ui` FULL GATE PASSED (client files
changed). INV-16 guard green; CLAUDE.md split/ratchet guards green; node --check clean on both
edited .gs/.js files.

REGRESSION RISKS:
- `getCallJourney` gains a parameter. It defaults to 'inbound' and every existing caller omits
  it, so the existing path is unchanged; an unknown value throws rather than silently falling
  through to a wider read.
- The capture link only fires where NO inbound match exists, so no existing link changes kind.
  Records already carrying an inbound link keep it, and NULL kind reads as inbound.
- Widest new exposure is bounded by the two-condition gate above and pinned both ways. The
  residual risk is the ruling itself (a Spanish manager sees a Field Ops agent's name and call
  outcome), which is the accepted, documented trade.
- `callerLookupShapeCall_` gained three fields; it is shared with Caller Lookup, where the extra
  keys are inert (that client reads named fields).

INVARIANTS AT RISK: None violated. INV-01 clean (read-only endpoint; capture is cdr-import).
getCallJourney remains deliberately uncached, so no INV-30 version moves. The F-4 gate is
REUSED unchanged rather than reimplemented -- deliberately, so a future change to entitlement
lands in one place.

NET SCORE: 0 - 0 = +0
  (Feature work on a drill that only starts working once Round-17 deploys; no defect was firing.
  Counted as a wash rather than claimed as a fix.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (capture + the ADD COLUMN) and the dashboard (reader + client). The DDL runs
  itself on the next import; no console step. | BLOCKS DEPLOY: N
- Links populate for dates imported AFTER deploy; `backfillInboundCalls` fills surviving
  `Call_Legs_*` dates once Neon is reachable. 08/21 ages out ~Sep 4. | BLOCKS DEPLOY: N
- Verification (needs Neon up): Spanish Missed report, 2026-08-21, the 7:14:57 abandon -> "↳
  path" -> expect the internal tag, "Internal request from Marie (Muskaan) Jindal · Field
  Operations (Market Activity)", and a working "on an active OUTBOUND call — view that call's
  path" link opening Marie's patient call (masked). Then confirm the NEGATIVE: a manager of an
  unrelated dept must get the not-entitled message for the same outbound id. | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`;
Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- No read-only preview was built for the outbound match (R11-N had one before it shipped). The
  chain diagnostic already detects and reports the ASSIST-DURING-OUTBOUND shape, which is the
  same population, so accuracy is observable there -- but it does not report whether the match
  is UNIQUE, which is what capture keys on. Worth adding before trusting the link at volume.
- Sub-60s internal abandons still have no entry point (DQE's sentinel threshold); owner ruling.
- The `not-entitled` path is unreachable from the UI today (the button only renders on a record
  the viewer could already drill). It exists for the RPC surface, where any call_id can be sent.
- Unchanged ledger: Outbound release runbook, the backfills, coaching arming, #49's re-export,
  the egress "top:" ranking read.

DOCUMENTATION UPDATES NEEDED:
- Applied: docs/known-issues.md carries the OWNER RULING in full (the decision, the alternative
  that was declined, the two-condition capability, what is disclosed, and how to narrow it later
  if revisited); CLAUDE.md's R11-N bullet gains the Step-4 sentence pointing at it.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
