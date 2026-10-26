---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: OBX-2 (owner 2026-10-26, follow-ups to OBX-1) -- (1) `diagnoseOutboundTransfers` names the coincidental case, a different employee's outbound call to the same number still live, as its own number-live-only kind "colleague on the same number" (was "other"), and flags each number-live-only call whose number is an insurer's line, counted per kind, no number logged; (2) Operator State #82 (+ fix-history, per-call-capture, the CLAUDE.md index line) records that the remaining number-live-only calls were owner-checked as genuine calls, so the number-live test must never become a capture rule.
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/outboundCalls.js, tests/unit/outbound-transfers.test.js, tests/README.md, CLAUDE.md, docs/operator-state.md, docs/fix-history.md, docs/per-call-capture.md

CHANGES:
OBX-2 (1) | outboundCalls.js | `OC_BONLY_KINDS_` gains 'colleague on the same number' (checked after duplicate dial: not the same agent, the other call is a captured outbound call, still live); `ocTransferHandoffs_(rawRows, opts)` takes an optional `opts.isInsurer(number)` and sets `insurer` on each row (the number never leaves the function; a throwing lookup reads false); `ocSummarizeHandoffs_` adds `insurer` + `kindsInsurer`; new `ocInsurerLookup_()` builds the test from Neon `insurance_numbers` (hashes via `cdrHashPhone_`, the same +digits space the capture hashes) through the existing `getReachableNeonConn_`, or returns OFF with the reason (no HMAC_SECRET / Neon unreachable / table unreadable or empty); the diagnostic logs "insurer flag: on (N insurer numbers)" or "OFF -- why", the insurer total and an insurer count per kind.
OBX-2 (2) | operator-state.md #82, fix-history.md, per-call-capture.md, CLAUDE.md | The new kind, the insurer flag, the second run's figures (797 = 519 redials / 203 other / 38 crossing / 36 duplicate / 1 untracked hand-over), the owner's finding (two departments calling the same insurer / facility, one on hold) and the rule: never turn the number-live test into a capture rule; fix-history OBX-2 row.
OBX-2 | outbound-transfers.test.js, tests/README.md | +4 tests (15 total): the colleague kind on a live call, a just-ended colleague call staying "other", the injected insurer flag (+digits space, per-kind counts, no number in rows or summary, throwing lookup -> false), and the lookup turning itself OFF with the reason; README map entry.

TEST RESULTS: `node --test` 2680 pass / 0 fail (2681 total, 1 skipped; TZ=America/Chicago); lint:gas clean (78 files); INV-16 guard clean; module-deps --check up to date. ci:ui not run locally (no dashboard / client file changed; CI runs it). Bite-checks 5/5 bite: colleague kind, colleague live-only, insurer flag, insurer summary count, lookup OFF without HMAC_SECRET.
REGRESSION RISKS: (1) The capture is untouched -- only the editor-run, read-only diagnostic changed; `ocTransferHandoffs_`'s new argument is optional, so existing callers behave as before. (2) The diagnostic now opens one Neon connection and reads `insurance_numbers` (a few dozen hashes) per run -- unmetered (cdr-import has no egress meter), negligible. (3) "other" shrinks by the colleague cases, so a later run's "other" is not comparable to the 203 of the first run. (4) A colleague's call that ended just before stays "other" by design (the owner's case was a live call on hold).
INVARIANTS AT RISK: INV-16 (outboundCalls.js is not a duplicated file -- guard clean); Operator State #55 (the DO NOT EDIT! insurance block stays single-reader: the diagnostic reads Neon's table, not the sheet). None violated.
NET SCORE: 0 production fixes (diagnostic + documentation only) − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- Optional: re-run `diagnoseOutboundTransfersAllDates()` after the push to see the colleague and insurer counts; the first log line says whether the insurer flag is on | BLOCKS DEPLOY: N
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f` (or `scripts/deploy.sh apps-script/cdr-import`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Carried from OBX-1: the inbound capture may record a transfer-chain call as a second inbound record (check against Raw Data first); the Direct report's "Sales Voicemails" pseudo-agent on dates built before the roster cell was removed.

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
