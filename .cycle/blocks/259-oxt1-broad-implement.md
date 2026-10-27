---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: OXT-1 (owner 2026-10-27) -- the outbound counterpart of IXT-1: transfers / consults / attempts to a person on a captured OUTBOUND call's journey, journey-only; both captures now check across each other; the read-only diagnostic covers both directions and sizes the long-hold risk.
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/outboundCalls.js, apps-script/department-dashboard/AgentDay.gs, apps-script/department-dashboard/OutboundReport.gs, tests/unit/outbound-calls.test.js, tests/unit/inbound-calls.test.js, tests/unit/outbound-call-mix.test.js, tests/unit/outbound-report.test.js, docs/operator-state.md, docs/per-call-capture.md, docs/fix-history.md, docs/regression-scenarios.md, docs/module-dependencies.md (generated), tests/README.md, CLAUDE.md (#84 index line), .cycle/STATE.md

CHANGES:
OXT-1 step 0 | inboundCalls.js | `diagnosePersonTransfers(date|'all')` now runs BOTH builders per held Call_Legs_* date and logs inbound + outbound: captured calls, calls gaining an event, linked transfers, timing-only attempts (calls with 1 / 2 / 3+), time since the call connected per timing attempt (<2m / 2-10m / 10-30m / 30m+, `IC_IXT_SINCE_BUCKETS_`), ambiguous skips incl. "agent on an inbound AND an outbound call at once", outside-number skips, call-id samples. New PURE `icIxtStatsLine_`; `icIxtFoldStats_` folds twoCalls + sinceConnect. Read-only.
OXT-1 step 1 | inboundCalls.js, outboundCalls.js | `icPersonTransferEnrich_` gains `opts` {otherBusy, otherSources, handoverNumber}: a timing attempt whose agent is live on calls in BOTH captures is ambiguous (twoCalls); the Transfer To claim map is built over both captures' calls, so a target named by one of each is claimed by neither, and a target owned by the other capture is left to it. `buildOutboundCallRecords_` runs it after the records are built (connected / talk / ring / attempts already computed), with its own live intervals = icBusyIndexes_'s outboundBusy over captured roots, the other side = agentBusy over the Incoming groups, and the hand-over leg matched to the number dialled; skipped under keepTransferTargets (the OBX diagnostics). `buildInboundCallRecords_` passes outboundBusy as the other side (IXT-1 gains the cross-capture check).
OXT-1 step 2 | AgentDay.gs, OutboundReport.gs | `agentDayInternalCallee_` skips `transfer:true` events (the Agent Day "To" label for a no-hash row + `obMixBucket_`'s colleague bucket); new PURE `obJourneyOwnEvents_` strips them before `obInstantDerivedRing_` and `obJourneyMarkerScores_` (an appended internal leg with a blank name reads '(unknown)', which the ring probe's step 3 would take for the external leg).

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 2709 pass / 0 fail (+10 tests); `npm run lint:gas` clean; INV-16 guard clean; module-deps regenerated (+1 symbol) and --check clean; claude-md-split 11/11. ci:ui: all stages passed. Bites 14/14 after two tests were sharpened: the other-capture target guard first did not bite (the two-claimant test reaches '#ambiguous' first) -- a target named ONLY by an inbound call now pins it, and without the guard the outbound build THREW (rec undefined), which would have cost a day's outbound capture; the keepTransferTargets guard did not bite until its test carried an attempt.
REGRESSION RISKS: (1) IXT-1 inbound now leaves out an internal dial placed while the agent was ALSO on a connected outbound call (by design; the diagnostic counts them as twoCalls). (2) `icPersonTransferEnrich_`'s signature gained an optional 5th arg; its only callers are the two builders. (3) The Transfer To claim map now includes the other capture's calls: a target that a captured inbound call AND an answered outbound-shaped group both name is no longer attached to the inbound call. (4) Outbound journeys can now hold up to IC_JOURNEY_MAX_EVENTS appended events; the Caller Lookup outbound card renders them with clJourneyRowHtml_ ("took the caller" reads for the person called).
INVARIANTS AT RISK: None -- journey-only (no count, disposition, connected / talk / ring / attempts moves); no number stored (hand-over matched in memory, events carry staff names / '(unknown)'); INV-16 files untouched; no public endpoint.
NET SCORE: 1 − 1 = 0 (the outbound path missing a transfer fires today -- OBX-1 measured 4.1% of captured outbound calls as continuations; new failure mode: a timing-only attempt during a long insurer hold may be about something else, which the 30m+ bucket sizes)

OPERATOR ACTIONS / DEPLOY:
- Deploy cdr-import AND the dashboard | BLOCKS DEPLOY: N
- Run `diagnosePersonTransfers('all')` (cdr-import editor) and send the outbound lines, especially the time-since-connect buckets + samples | BLOCKS DEPLOY: N
- Not retroactive: `backfillOutboundCalls(from, to, true)` over the held dates, then the Outbound Calls tab export (#50); IXT-1's `backfillInboundCalls(from, to, true)` + Inbound Calls export also picks up the cross-capture check | BLOCKS DEPLOY: N
- Walk S38's OXT-1 step | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- If the diagnostic shows many 30m+ outbound timing attempts with unrelated samples, limit the outbound TIMING half (e.g. a cap on time since connect) -- the linked half stands on its own.
- The colleague who took over a call still sees nothing on their own Agent Day (inbound and outbound) -- carried from IXT-1.
- team-tools link (owner 2026-10-27: rep + note time, confirmed by the phone hash where possible) -- separate repo; needs push access or a team-tools session.
- DCA step 2 (CDR Historical per-agent build, extension-only) -- carried.

DOCUMENTATION UPDATES NEEDED:
- None (Operator State #84, per-call-capture.md, fix-history OXT-1, tests/README, S38 and the CLAUDE.md #84 line updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
