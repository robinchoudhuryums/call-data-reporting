---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- R18c (owner, pre-rollout audit) | The subscriber-blast double-send protection was one-directional: a manual blast claimed the marker so the AUTOMATION could not re-send, but nothing warned or stopped a manual send after the automation (or another admin) already had.

Files modified:
- apps-script/department-dashboard/QueueReportEmail.gs
- apps-script/department-dashboard/script-11-qcd-boot.html
- tests/unit/queue-report.test.js
- docs/operator-state.md (item 31)
- CLAUDE.md (the dsConfirm_ bullet's wired-callsites line)

CHANGES:
R18c | script-11-qcd-boot.html | The blast click now fetches the day's send state FRESH (`getQueueReportInit`, already an admin RPC returning `lastSent`) before showing the confirm. When `lastSent` equals the displayed day, the dialog switches to the danger tone, says the report was ALREADY sent to subscribers today, and relabels the confirm "Send a second copy". The un-warned dialog also gained one honest sentence: repeat sends of an OLDER day are not tracked (the marker only ever records the gate's current target day; there is no per-date send log to warn from).
R18c | QueueReportEmail.gs | `sendQcdAllDeptToSubscribers` REFUSES an unforced send when `lastSent === date`, with a "re-open the dialog" message. The client passes `force:true` only when ITS dialog warned, so the server refusal fires exactly in the race window -- the automated poll or a second admin sent between the dialog opening and the click -- where a client-only warning would have been cosmetic. A warn-read failure degrades safely: the dialog renders un-warned and the server still refuses the unforced send.
R18c | tests/unit/queue-report.test.js | Pins the refusal (unforced repeat throws), its scope (a DIFFERENT day never trips it), and the bypass (force does). The suite's loader gained Auth.gs because this is its first test through an `assertAdmin_`-gated RPC -- the test signs in as the admin so it exercises the marker guard, not the auth gate.

TEST RESULTS: passed. `node --test` 675/675 (+1); INV-16 green; `npm run ci:ui` all stages. Both dialog states probed live in the harness (the already-sent case by temporarily setting the fixture's `lastSent`, then restoring it): fresh day -> neutral dialog, "Send now", `force:false`; already-sent day -> danger tone, warning text, "Send a second copy", and `force:true` observed in the actual RPC arguments.

REGRESSION RISKS:
- One extra admin-only RPC per blast click (the fresh `lastSent` read). Rare path, cheap payload.
- The dsConfirm_ call previously passed a `danger:` key that is not part of its API (`tone:` is); caught while wiring the warning. Harmless before (ignored) but worth knowing the dialog API takes `tone: 'danger'`.
- Legitimate re-sends (a subscriber added after the morning send) still work -- that is what the forced path is FOR; the dialog just makes the second copy an informed choice.

INVARIANTS AT RISK: None. INV-01 unchanged (the RPC stays assertAdmin_-gated; the new branch only ADDS a refusal). The O-1/Round-16 send semantics (one To+Cc message, marker claim, LAST_RESULT never written by manual sends) are untouched.

NET SCORE: 1 production fix − 0 new failure modes = 1
(Would it have fired? The owner is rolling out today and asked specifically about double-notify safeguards before touching the button -- the gap was real and the trigger scenario, an admin blasting after the automated morning send, is the button's most likely first use.)

OPERATOR ACTIONS / DEPLOY:
- None new.
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- A repeat blast of an OLDER day still cannot be detected (no per-date send log). The dialog now says so; adding a log sheet would close it but is not worth the state for a button used a few times a month.

DOCUMENTATION UPDATES NEEDED:
- DONE: docs/operator-state.md item 31 carries the two-directional dedupe story (marker claim one way, forced-refusal the other, and the older-day limitation); CLAUDE.md's dsConfirm_ bullet now lists the blast as a wired callsite with the tone-varying pattern.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
