---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: OBX-1 (owner 2026-10-26) -- the outbound capture counted a warm-transfer continuation (the receiving rep's leg to the customer, which 8x8 logs as a new Outgoing call) as that rep's outbound call. (1) Rule A: `buildOutboundCallRecords_` skips a call another call names in "Transfer To Call ID" (Raw Data col P), ignoring a call's own queue leg; an outbound chain keeps the original agent's call. (2) `diagnoseOutboundTransfers` sorts every number-live-only (B-only) call by shape -- untracked hand-over / redial / duplicate dial / crossing call / other -- with counts and samples, and reports what rule A now leaves out. (3) Whole numbers (no ".0") in the diagnostic's log.
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/outboundCalls.js, apps-script/cdr-import/inboundCalls.js, tests/unit/outbound-transfers.test.js, tests/README.md, CLAUDE.md, docs/operator-state.md, docs/per-call-capture.md, docs/fix-history.md, docs/regression-scenarios.md

CHANGES:
OBX-1 (1) | outboundCalls.js | `OC_TRANSFER_TO_COL_` = 15 + `ocTransferSources_(rawRows, rootOf)` (target root -> first source root naming it, skipping a call naming itself); `buildOutboundCallRecords_` drops a named target after Gate 1 (`records._transferDropped`), each record carries `transferFrom`; `opts.keepTransferTargets` keeps them for the diagnostic only; `writeOutboundCallsToNeon` logs the count left out.
OBX-1 (2) | outboundCalls.js | `ocTransferHandoffs_` builds with `keepTransferTargets`, finds the B match (customer number live on another call within 5 s), and classifies B-only calls in order: consult leg between this agent's ext and a peer ext on the other call -> untracked hand-over; same agent, other call ended -> redial; same agent, other call outbound -> duplicate dial; other call inbound and still live -> crossing call; else other. `ocSummarizeHandoffs_` adds kinds, gap buckets (0-1 s / 2-5 s / live) and per-kind samples; `diagnoseOutboundTransfers` reports A (now left out, by agent, inbound vs outbound chain) and B-only by kind. No phone numbers are logged.
OBX-1 (3) | outboundCalls.js, inboundCalls.js | `ocN_` formats every logged count as a whole number; `icLoadConfiguredQueueNames_`'s count via `String()`.
OBX-1 | outbound-transfers.test.js | The old test that pinned the bug (C counted as the receiving rep's outbound) now pins its exclusion; outbound chain keeps only the original call; new tests for redial, untracked hand-over (owner's 10/22 example with col P stripped), duplicate dial, crossing call, the summary's kinds/gaps, and a whole-numbers source pin. 11 tests.
OBX-1 | docs | Operator State #82 rewritten (rule, measurement, not retroactive, the shapes); CLAUDE.md #82 index line; per-call-capture "Outbound-call capture" note (the inbound side's `outboundBusy` index still counts these calls on purpose); fix-history OBX-1; tests/README map; S56 step.

TEST RESULTS: `node --test` 2676 pass / 0 fail (2677 total, 1 skipped; TZ=America/Chicago); lint:gas clean (78 files); INV-16 guard clean; module-deps --check up to date. ci:ui not run locally (no dashboard / client file changed; CI runs it). Bite-checks 7/7 bite: rule A, the own-queue-leg skip, consult signature, redial, duplicate dial, crossing call, whole numbers (the last bit only after the pin read multi-line Logger.log calls -- a ';' in a format string had cut it short).
REGRESSION RISKS: (1) Outbound counts drop ~4% going forward (1491 of 36,391 calls over the 9 held dates measured); every outbound surface (Outbound report, My Department outbound, Overview tiles, callbacks, Caller Lookup) reads fewer calls from the deploy on. (2) NOT retroactive: stored dates keep the continuations until rebuilt, so a window spanning the deploy mixes the two rules until `backfillOutboundCalls(from, to, true)` runs. (3) A transfer target whose source leg lacks the Transfer To link (the B-only "untracked hand-over" shape) stays counted -- sized by the diagnostic, no rule built. (4) A rep who genuinely calls a customer back on a call 8x8 linked by Transfer To would be left out -- not seen in the 9-day measurement (A-only = 5 calls).
INVARIANTS AT RISK: INV-01 (no new public write -- diagnostics are editor-run, read-only), INV-16 (outboundCalls.js / inboundCalls.js are not duplicated files -- guard clean). None violated.
NET SCORE: 1 production fix (continuations were counted as outbound calls this month) − 0 new failure modes = 1

OPERATOR ACTIONS / DEPLOY:
- After the push, rebuild the held outbound dates: `backfillOutboundCalls(from, to, true)` over the window the reports are read over (Operator State #82 / #50) | BLOCKS DEPLOY: N
- Re-run `diagnoseOutboundTransfersAllDates()` and read the B-only kinds; report the counts + check a few samples per kind | BLOCKS DEPLOY: N
- Re-run the Outbound Calls tab export (#50) after the backfill so the sheet fallback matches | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A second rule for the "untracked hand-over" B-only shape, decided from the diagnostic's counts and samples (owner).
- The inbound capture may record the transfer-chain call as a second inbound record; check against Raw Data before changing anything.
- The Direct report's "Sales Voicemails" pseudo-agent on dates built before the roster cell was removed: re-run `runDirectCallBuild` / re-import, or a one-time cleanup (offered, not built).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (Operator State #82, CLAUDE.md index line, per-call-capture, fix-history OBX-1, tests/README, S56).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
