---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- IT-6 | The per-call journey drill was not exercised by `npm run ci:ui` AT ALL. Three client
  renderers added by Steps 3 and 4 -- the "Internal request from …" origin line,
  `outboundJourneyHtml_`, and the not-entitled refusal copy -- were unit-pinned server-side but
  had NEVER executed in a browser. New asserting driver + the mock that makes it reachable.

Files modified:
- tools/ui-harness/drive-journey.js    (NEW -- 14 asserting checks)
- tools/ui-harness/build-harness.js    (getCallJourney mock, request-keyed)
- tools/ui-harness/ci.mjs              (new blocking stage + the header comment)
- CLAUDE.md                            (the ci:ui block names the new stage)

CHANGES:

IT-6 | build-harness.js | `getCallJourney` was deliberately unmocked, which is precisely WHY no
driver could reach the drill: drive-smoke's unmocked-RPC check would have flagged the call, so
nothing ever clicked a "↳ path" button. The mock is keyed off the REQUEST so one walk covers
all three renderers without three fixtures: `kind='outbound'` returns the linked outbound call;
a call id ending '000' returns `{found:false, reason:'not-entitled'}`; anything else returns an
INTERNAL record carrying `originAgent`/`originDept` and an OUTBOUND-kind related link. The
inbound fixture therefore exercises the Step 3 origin line AND produces the outbound-flavored
related button that step 2 of the walk follows.

IT-6 | drive-journey.js | Opens My Department over the 30-day window, waits for the drill
buttons, and walks: (1) the internal-assist render -- overlay opens, `.cj-origin` line names
the requester, the internal tag renders, the related button carries `data-cj-kind="outbound"`
and the copy says OUTBOUND rather than inbound; (2) follows the link -- the outbound call
renders with its agent, a connected/talk outcome rather than a queue disposition, real chain
tokens and event rows (proving it reuses the shared renderers), and NO caller identity (the
callee reads "(external number)" and no 10-digit string appears anywhere); (3) the refusal --
driven through the client's OWN entry point by retargeting a real button at a refused id, so
the branch renders through the real handler rather than a stub, and no call payload leaks into
it. Plus the two hygiene checks every asserting driver carries: no unmocked RPCs, no page or
console errors.

TWO THINGS THE FIRST RUN GOT WRONG, both found by running it rather than by reading:
the per-agent cards and the queue-only abandoned block render into `#dept-missed-detail`, a
SEPARATE lazy fetch from `#dept-missed-section`'s own summary -- so a `#dept-missed-section
.pid-journey` selector found nothing; and the detail settles around 6 s, well past the fixed
2.5 s sleep the first draft used. The driver now waits on the buttons themselves
(`waitForFunction`) and queries page-wide. A fixed sleep here would have been a flaky stage in
CI rather than an honest one.

IT-6 | ci.mjs | Wired as a BLOCKING stage between drive-subqueue and drive-devoverlay, with the
header comment updated so the stage list stays accurate.

TEST RESULTS: PASSED -- unit 904/904 (unchanged; this is harness-only work, no product code
touched). `npm run ci:ui` FULL GATE PASSED with the new stage: 14/14 in drive-journey, all
other stages unchanged (84/84, 16/16, 30/30, 14/14, 20/20). INV-16 guard green; CLAUDE.md
split/ratchet guards green; ui-harness-vendor pins green.

REGRESSION RISKS:
- Harness-only: no `apps-script/` file changed, so nothing ships to production from this
  increment. The risk is CI flakiness, addressed above by waiting on the DOM condition instead
  of the clock.
- The new mock makes `getCallJourney` answered everywhere in the harness, so a future driver
  that clicks a path button will get a fixture instead of an unmocked-RPC flag. That is the
  point, but it does mean the drill is no longer part of drive-smoke's "unmocked is expected"
  audit -- deliberate, and the drill now has its own stage instead.
- `drive-journey` asserts on fixture strings ("Marie (Muskaan) Jindal"). If the mock changes,
  the driver must change with it; both live in this repo and fail loudly together.

INVARIANTS AT RISK: None. No product code, no schema, no cache key, no auth path touched --
the entitlement logic this driver renders against is the server's, unchanged since 146.

NET SCORE: 0 - 0 = +0
  (Pure coverage. No defect was found by adding it -- all three renderers worked on the first
  real click -- so it is honestly a wash, not a fix. Its value is the next regression, which
  the .gs harness structurally cannot see.)

OPERATOR ACTIONS / DEPLOY:
- None. Nothing in `apps-script/` changed, so there is nothing to push or deploy for this
  increment. | BLOCKS DEPLOY: N
Deploy: N/A -- harness/CI only.

FOLLOW-ON ITEMS:
- Sub-60s internal abandons still have no entry point of their own (reachable via a heatmap
  cell drill or the Inbound report, not the Missed report). Owner ruling, unchanged.
- Still the standing operator ledger: run `previewOutboundAssistLinks` on a date or two before
  trusting the Step 4 link at volume; deploy cdr-import + dashboard for increments 144-146; the
  08/20-08/21 backfills before the ~Sep 4 retention edge; Outbound release runbook; coaching
  arming; #49's one-time re-export; the egress "top:" ranking read.

DOCUMENTATION UPDATES NEEDED:
- Applied: CLAUDE.md's ci:ui block names drive-journey.js among the asserting stages and says
  what it covers. Nothing else -- the drill's behavior is already documented in the R11-N
  bullet and the Step 4 owner ruling.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
