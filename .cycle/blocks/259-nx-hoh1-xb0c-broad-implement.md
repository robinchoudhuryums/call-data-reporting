---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: NX-1 (owner 2026-10-29) -- the path's "N." step relabelled; HOH-1 -- hold-hangup wording (owner go after HOH-0b: 149/149 flags on the call's last leg); XB-0c -- sub-queues fold into their parent and entry queues are ignored in the bounce diagnostic (owner: "PAP is a part of Sales", "MWC is Sales").
New capabilities (G/ST): NX-0 -- read-only `diagnoseOutsideNumberLegs` (owner: "is there a way to find out for certain?" whether "N." is an 8x8 artifact).
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/cdr-import/transferFilter.js, apps-script/department-dashboard/script-10-escalations.html, apps-script/department-dashboard/script-5-dept.html, apps-script/department-dashboard/script-9-inbound-direct.html, apps-script/department-dashboard/script-4-nav.html, apps-script/department-dashboard/InboundReport.gs, apps-script/department-dashboard/styles.html, tests/unit/inbound-calls.test.js, tests/unit/transfer-filter.test.js, tests/unit/hold-hangup-label.test.js (new), tests/unit/inbound-email.test.js, tools/ui-harness/drive-admin.js, tests/README.md, docs/operator-state.md (#85, #86, #87 new), docs/fix-history.md, docs/per-call-capture.md, docs/regression-scenarios.md (S38), CLAUDE.md (#87 index line)

CHANGES:
NX-1 | inboundCalls.js | `icBuildJourney_(legs, opts)`: a leg whose callee is an outside number reads "(caller)" when it is `opts.callerNumber` (the inbound capture passes it), "(external number)" when its name is blank / N/A, else the masked CNAM -- the N/A check now runs BEFORE the IMP-12 initials mask that turned "N/A" into "N.". Outbound passes no caller number, so its dialled party with no name reads "(external number)", the marker `obInstantDerivedRing_` reads first.
NX-0 | inboundCalls.js | PURE `icOutsideLegShape_` (mirror / carrier / alone / otherNumber + direction, answered, blank name, from an agent extension, transfer-target call, shared SIP id, onlyAnswer, decidesDept), `icOutsideLegsForGrid_`, `icOutsideLegLine_`, `icTopCounts_`; editor `diagnoseOutsideNumberLegs(date|'all')` + `...AllDates()`; IC_COL gains SIP_CALL_ID: 35.
HOH-1 | inboundCalls.js | `opts.markHoldHangup` stamps `holdHangup: true` on the Incoming leg carrying Caller Disconnect On Hold (inbound capture only).
HOH-1 | script-10-escalations.html, script-5-dept.html, styles.html | PURE `clHoldHangupIdx_` (stamp, else the last answer by a person -- placeholders, masked initials, consults and the prefixed origin hop skipped); `clJourneyRowsHtml_` replaces the four `journey.map(clJourneyRowHtml_)` calls (the map index would otherwise be read as the new flag); `clJourneyRowHtml_(ev, holdHere)` adds "caller hung up here while on hold" + `.cl-ev-holdhang`; `clOutcomeChip_` reads "Hung up while on hold with <agent>" on an answered call (unanswered keeps "Hung up on hold"); the path drill header adds "· hung up while on hold".
HOH-1 | script-9-inbound-direct.html, script-4-nav.html, InboundReport.gs | "hung up while on hold — after an agent answered, so counted inside Answered"; the CSV KPI row + breakdown column; the drill rows say "hung up while on hold" instead of "abandoned on hold"; the headline sentence and the email row.
XB-0c | transferFilter.js | `tfBounceLookups_` folds a dept into its Dept Config Overview Parent (col C, one level) for both queues and roster agents and returns `parentOf`; `TF_BOUNCE_ENTRY_QUEUES_` (UDC_A_Q_Main, UUC_A_Q_Main, A_Q_AfterHours) ignored and counted (`entryQueues`, not a skipped step); the log's first lines name the folded sub-queues and the entry queues.

TEST RESULTS: `TZ=America/Chicago node --test` 2764 pass / 0 fail (+11); lint:gas clean; module-deps up to date; INV-16 guard in sync; ci:ui -- see the addendum. Bites (cdr-import) 9/9: the "(caller)" rule, the N/A-before-mask order, NX-0's mirror / carrier / department tests, the capture stamp and its Incoming-only rule, the parent fold, the entry queues.
REGRESSION RISKS: (1) New journeys read "(caller)" / "(external number)" where they read initials / "N." / "(unknown)" -- the outbound ring reader prefers "(external number)" by design; AgentDay's roster match never matched a placeholder. (2) An answered call's chip text changed; the abandoned one did not. (3) The Inbound CSV's KPI label and breakdown column header changed (anyone parsing the CSV by label). (4) Stored journeys keep "N." until re-imported or aged out.
INVARIANTS AT RISK: None -- no count, cache key or payload shape changed (journey events gain an optional `holdHangup` field); no phone number reaches a log or the page.
NET SCORE: 2 − 0 = 2 (NX-1 and HOH-1 fix labels that misled a reader today; NX-0 / XB-0c are research)

OPERATOR ACTIONS / DEPLOY:
- Push cdr-import and run `diagnoseOutsideNumberLegsAllDates`; send the log (it decides whether the artifact legs should leave the path and the answered / department tests) | BLOCKS DEPLOY: N
- Add ACTIVE Dept Config rows: PAP (QCD Queues A_Q_PAP, Overview Parent Sales), Spanish (A_Q_Spanish, CSR), PAK (A_Q_PAK, Power); add A_Q_Sales_MWC to Sales' "Inbound queue aliases" and A_Q_BackUp_FieldOps to FieldOps (all three of its queues); then re-run `diagnoseTransferBouncesAllDates` | BLOCKS DEPLOY: N
- Walk S38's HOH-1 and NX-1 steps after the deploys | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- NX-2 (after the NX-0 log): if the mirror / carrier legs are artifacts, drop them from the path and from the answered / final-department tests -- moves figures, owner to approve.
- XB-1 (after the re-run with the rows): the stored "came back" record + a Caller Lookup chip and a monthly count, as proposed.

DOCUMENTATION UPDATES NEEDED:
- None (Operator State #85 / #86 / #87, CLAUDE.md #87, fix-history, per-call-capture, S38, tests/README updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
