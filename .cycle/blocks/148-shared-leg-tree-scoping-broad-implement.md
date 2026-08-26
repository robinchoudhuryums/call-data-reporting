---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- (1) Internal-origin `answered` was derived from ANY talk leg in the CDR root, so a
  sibling agent's external customer leg under a shared leg tree marked a genuinely-
  abandoned internal assist as `answered` -- shrinking the one population the path
  drill serves.
- (2) `previewOutboundAssistLinks` did not measure the shared-root overlap or the
  drill's actual abandon population, so both had to be eyeballed out of the log.
- (1a, prerequisite found while testing) The originator identity for an internal-origin
  record came from `legs[0]`, which on a shared tree can be a colleague's leg that
  merely started first -- naming the wrong requester AND scoping (1) to the wrong person.

Files modified:
- apps-script/cdr-import/inboundCalls.js
- tests/unit/inbound-calls.test.js
- CLAUDE.md
- docs/known-issues.md
- tests/README.md

CHANGES:
(1) | apps-script/cdr-import/inboundCalls.js | New pure helper `icLegFromOriginator_(leg,
    originExt, originName)`: a leg belongs to the originator when its caller EXT or its
    caller NAME matches, and never when it is an Outgoing leg to an external number (the
    party answering an internal queue call is always an internal extension). `answered`
    now applies it for `isInternalOrigin` records only -- external-inbound records keep
    the whole-tree test byte-identical, since every leg there descends from the one
    incoming caller. The NAME arm is load-bearing: the queue-fronted delivery leg renders
    CALLER as `CallQueue (144)` with CALLER_NAME still the originator, so an ext-only rule
    would false-negative into phantom abandons.
(1) | apps-script/cdr-import/inboundCalls.js | `abandonLeg` now PREFERS an originator-scoped
    abandoned leg (so `abandonStage` reads the right leg's cells) and FALLS BACK to the
    unscoped search. Without the fallback, a fan-out leg carrying the flag would downgrade
    a real abandon to `missed` -- a new failure mode the scoping would otherwise introduce.
    The fallback is safe because `abandonLeg` is only consulted when nothing answered.
(1a) | apps-script/cdr-import/inboundCalls.js | The originator (`origin_agent`,
    `origin_dept`, and the ext `_originExt` that the related-call match keys on) now comes
    from the earliest QUEUE leg rather than `legs[0]`. TIMING fields (`call_start`,
    `call_date`, `wait_seconds`) deliberately still key on `legs[0]`: this changes identity,
    not the record's clock.
(2) | apps-script/cdr-import/inboundCalls.js | `previewOutboundAssistLinks` now flags each
    offending line inline (`** SHARED ROOT: <id> is ALSO an assist record in this run (@ t
    by <agent> -> <queue>)`) and adds two closing lines: the shared-root overlap ratio, and
    the drill population (`N abandoned (K of them linked)`) separated from the answered
    noise the drill never reaches.
(1,1a,2) | tests/unit/inbound-calls.test.js | Seven new tests: the sibling external leg no
    longer marks an assist answered; the originator being answered still reads answered;
    the queue-fronted delivery leg matches on the NAME arm; external inbound keeps the
    whole-tree test; a fan-out leg carrying Abandoned still yields an abandon (the fallback);
    the originator is the earliest QUEUE leg not the earliest leg; and the preview reports
    both new counters.

TEST RESULTS: passed. `node --test` 911/911 (was 904; +7). `bash scripts/check-duplicated-files.sh`
clean. `npm run ci:ui` -- all seven asserting stages passed (exit 0), unchanged as expected
(no client, payload-shape or dashboard file was touched).

REGRESSION RISKS:
- `buildInboundCallRecords_` is consumed by `writeInboundCallsToNeon`, the deferred
  `mirrorInboundForDate_` drain, `backfillInboundCalls`, and three preview diagnostics.
  All three changed fields (`disposition`, `origin_agent`/`origin_dept`, `related_call_id`
  via `_originExt`) are journey/descriptive only: every dashboard metric query excludes
  `is_internal`, and `getCallJourney` looks the row up by `(call_date, call_id)` with NO
  disposition filter -- verified in InboundReport.gs. So no metric moves and no drill
  becomes unreachable.
- External-inbound records are provably untouched: the scoping is gated on
  `isInternalOrigin`, and a test pins the unchanged whole-tree behavior.
- `_originExt` feeds the related-call match, so a shared tree can now link differently
  than before. That moves it TOWARD correctness (it keys on the agent who actually dialed
  the queue); on a non-shared tree `legs[0]` IS the queue leg, so nothing changes. The four
  existing Step-4 link tests pass unmodified.
- Old rows keep their previous values until re-imported; within the ~14-day `Call_Legs_*`
  retention a force re-import heals them, past it they do not. Descriptive fields only.
- Where the old behavior was arguably better: a merged tree whose queue call really was
  answered by a leg neither arm recognizes now reads `abandoned` instead of `answered`.
  Both validated 2026-08-21 shapes pass, and the failure adds a row to the drill's
  population rather than removing one.

INVARIANTS AT RISK: None. INV-16 does not cover `inboundCalls.js` (cdr-import only, no
duplicate copy) and the guard passes. INV-30 needs no bump -- nothing cached reads these
fields. INV-01 untouched (no new public function; the two previews stay editor-run and
read-only). INV-23/INV-54 unaffected: `icIsQueueName_` is read, never widened.

NET SCORE: 2 production fixes (the answered mis-derivation and the wrong-requester
identity, both firing daily on warm transfers) − 0 new failure modes = 2
(The abandon-leg fallback exists specifically so the scoping introduces none.)

OPERATOR ACTIONS / DEPLOY:
- Redeploy cdr-import for this change to take effect. | BLOCKS DEPLOY: N
- STILL OUTSTANDING FROM PR #256: all three projects are running the rejected JDBC
  timeout params until redeployed. That is the Daily Call Queue Report delay and it
  affects every Neon path. | BLOCKS DEPLOY: N (separate, and more urgent than this)
- Optional: re-run `previewOutboundAssistLinks` after the redeploy to read the two new
  counters against a real day and confirm the abandon population grew as expected.
Deploy: `cd apps-script/cdr-import && clasp push -f`

FOLLOW-ON ITEMS:
- The `outbound_calls` capture also admits these merged trees (its gate is no-Incoming +
  an answered external Outgoing leg, which a shared tree satisfies), so the Outbound
  report counts that leg as the answering agent's outbound activity and one root can name
  a row in both tables. The leg is genuinely that agent's, so the count is defensible --
  left unchanged deliberately, now measured on every preview run.
- OWNER RULING NEEDED: ~92% of the internal assist population is `answered` (170 of 185 on
  2026-08-24) -- assists that succeeded, which no surface drills. Narrowing the capture to
  non-answered internal-origin queue calls would cut ~170 rows/day against the live Neon
  transfer ceiling. Reversible, but it changes what is captured.
- `call_start` / `call_date` / `wait_seconds` still derive from `legs[0]` on a shared tree,
  so an internal record's clock can start at a colleague's leg. Left alone: `call_date`
  feeds the P-1 stray-record guard and the authoritative per-date delete, so moving it is
  a separate, higher-risk change.
- Sub-60s internal abandons still have no entry point (carried from the prior cycle).

DOCUMENTATION UPDATES NEEDED: Applied in this session.
- CLAUDE.md: new Common Gotchas bullet "A CDR root is a leg TREE, not a call" (2.1 KB,
  under the per-bullet ratchet; claude-md-split.test.js passes).
- docs/known-issues.md: new entry "A CDR 'root' is a leg tree, not a call (found by the
  Step-4 validation run, 2026-08-25)" carrying the full 2026-08-24 tally, the two-gate
  table, the three fixes and the two open items.
- tests/README.md: the inbound-calls / outbound-calls line names the new pins.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
