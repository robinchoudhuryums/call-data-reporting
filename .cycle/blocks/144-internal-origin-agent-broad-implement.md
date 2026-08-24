---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- IT-2 (Step 3) | Internal-origin records carried NO indication of who placed the call, so the
  receiving dept's newly-working path drill read "an internal call abandoned in your queue" --
  true and useless. `origin_agent` / `origin_dept` now capture the requesting employee and
  their raw CDR org label from the leg's CALLER columns, and the drill renders them.

Files modified:
- apps-script/cdr-import/inboundCalls.js                   (helpers, record fields, DDL, upsert)
- apps-script/department-dashboard/script-5-dept.html      (journey drill renders the origin line)
- apps-script/department-dashboard/styles.html             (.cj-origin)
- tests/unit/inbound-calls.test.js                         (+3 tests, 49 in file)
- CLAUDE.md                                                (R11-N bullet: the Round-17b sentence)

CHANGES:

IT-2 | inboundCalls.js | Root cause: `firstAgent` scans the group's legs for the first
non-queue, non-phone CALLEE name — and an internal-origin group's only callee IS the queue,
which `icIsQueueName_` skips. So `first_agent` is structurally always null for exactly this
population. The originator was sitting unread in the CALLER columns the whole time.

Two pure helpers beside the existing ones: `icOriginAgentName_(leg)` (CALLER_NAME, col 9) and
`icOriginDeptLabel_(leg)` (DEPARTMENTS, col 36). `icOriginAgentName_` mirrors firstAgent's
guards exactly — blank / 'N/A', queue names via icIsQueueName_, and phone-shaped values are all
rejected, so a raw number can never land in the column (the same PHI rule, not a new one).
The record gains `originAgent` / `originDept`, both hard-gated on `isInternalOrigin`, so every
externally-originated record is byte-identical to before. Neon: two idempotent
`ADD COLUMN IF NOT EXISTS` statements plus the insert column list and the DO UPDATE set, the
established pattern for this table. Values validated against the owner's real 2026-08-21 legs
("Marie (Muskaan) Jindal" / "Field Operations (Market Activity)").

Deliberately NOT reused: `first_agent`. It has a documented derived meaning (a direct-DID
line's dominant first_agent names the line's owner), and overloading it for internal rows
would poison that derivation the day someone stops excluding is_internal from it. A separate
column costs two DDL lines and cannot be misread.

Client | script-5-dept.html + styles.html | `callJourneyHtml_` renders "Internal request from
<b>Name</b> · <org label>" for internal records that carry an originator, on BOTH the
full-journey and the pre-extension-summary branches. Deliberately styled as CONTENT
(`var(--ink)`), not muted chrome like the sibling `.cj-related` line: for the receiving dept
this is the sentence that reclassifies the abandon from "lost customer" to "colleague needed
help". Inert on every existing payload (no originAgent → empty string).

Tests | inbound-calls.test.js | +3, from the real leg shape: the Field-Ops-dials-Spanish case
captures both fields while `firstAgent` STAYS NULL (asserted explicitly — that null is the hole
this fills, and a future "fix" that papers over it by reusing firstAgent should fail here);
phone-shaped and queue caller names yield null, and a blank org label yields null rather than
the literal string; externally-originated calls carry no originator at all.

TEST RESULTS: PASSED — 892/892 (was 889; +3). `npm run ci:ui` FULL GATE PASSED (client files
changed). INV-16 guard green; CLAUDE.md split/ratchet guards green; node --check clean.

REGRESSION RISKS:
- Externally-originated records are unchanged by construction (both fields are ternary-gated on
  isInternalOrigin), which is the population every metric query reads. The internal population
  is journey-only and excluded from all metrics, so no figure anywhere can move.
- The two new columns are additive; `getCallJourney` selects `to_jsonb(c)` (the whole row), so
  the read side needed no change and older rows simply carry NULLs until re-imported.
- PHI: `origin_agent` stores an EMPLOYEE name (same class as the existing first_agent), never a
  caller. The phone-shaped guard is copied from firstAgent rather than reinvented.
- `origin_dept` holds the RAW CDR org label, which matches no dashboard dept header. It is
  rendered as context only; nothing keys attribution on it, and nothing should start to.

INVARIANTS AT RISK: None. INV-01 untouched (capture-side, cdr-import). No cache version
affected — getCallJourney is deliberately uncached. The is_internal metric exclusions are
untouched.

NET SCORE: 0 − 0 = +0
  (Nothing was mis-computing: this is missing CONTENT on a drill that itself only starts
  working when Round-17 deploys. Counted honestly as a wash rather than claimed as a bug fix.)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import (capture + DDL) and the dashboard (the rendered line). The two ADD COLUMN
  statements run themselves on the next import — no console step. | BLOCKS DEPLOY: N
- Values populate for dates imported AFTER deploy; `backfillInboundCalls` fills surviving
  `Call_Legs_*` dates once Neon is reachable. 08/21 ages out of that window ~Sep 4. | BLOCKS
  DEPLOY: N
- Verification (needs Neon up): Spanish dept Missed report, 2026-08-21, the 7:14:57 abandon →
  "↳ path". Expect the "internal call" tag AND "Internal request from Marie (Muskaan) Jindal ·
  Field Operations (Market Activity)". | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`;
Department Dashboard: `scripts/deploy.sh . <dashboard-deployment-id>`.

FOLLOW-ON ITEMS:
- Step 4 (linking the assist to the requester's concurrent OUTBOUND call) is investigated and
  written up for the owner in chat, not implemented — it needs a ruling on a cross-dept
  entitlement question, not just code. Summary: the data exists (`outbound_calls` captures
  Marie's patient call), but a link would let the RECEIVING dept drill into the ORIGIN dept's
  customer call, which the F-4 per-dept gate exists to prevent. A metadata-only variant
  ("the requester was on a live call, 5:39 talk") delivers most of the value with no new
  entitlement surface; recommended over the full drill.
- Sub-60s internal abandons still have no entry point (DQE's sentinel threshold); owner ruling.
- Unchanged ledger: Outbound release runbook, the 08/20-08/21 backfills, coaching arming, the
  #49 export-trigger re-export, the egress "top:" ranking read.

DOCUMENTATION UPDATES NEEDED:
- Applied: CLAUDE.md's R11-N bullet gains the Round-17b sentence (the fields, why firstAgent is
  structurally null here, the NULL-on-external rule, the PHI guard). Nothing else — the
  known-issues entry written for the CallRecording/outbound-blind-spot investigation already
  carries the surrounding context.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
