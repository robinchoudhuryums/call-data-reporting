---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: QF-1 (owner 2026-10-28, Caller Lookup point 2) -- a queue's first ring was listed before the queue; QF-2 (point 4) -- the escalation card buttons rendered as one solid black bar with no hover labels, and Delete looked disabled; QF-3 (point 7) -- the expanded agent panel looked detached from its row.
New capabilities (G/ST): None
Files modified: apps-script/cdr-import/inboundCalls.js, apps-script/department-dashboard/CallerLookup.gs, apps-script/department-dashboard/script-10-escalations.html, apps-script/department-dashboard/styles.html, tests/unit/inbound-calls.test.js, tests/unit/caller-lookup.test.js, tools/ui-harness/drive-admin.js, tools/ui-harness/drive-agentpanel.js, docs/per-call-capture.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/regression-scenarios.md, docs/module-dependencies.md (generated), tests/README.md, .cycle/STATE.md

CHANGES:
QF-1 | inboundCalls.js, CallerLookup.gs | New PURE `icQueueFirstWithinSecond_` (capture; `icBuildJourney_` returns through it, so inbound AND outbound journeys) and its display twin `clQueueFirstWithinSecond_`, run by both `callerLookupShapeCall_` and `callerLookupShapeOutbound_` -- the shapers behind Caller Lookup, the "↳ path" drill and their sheet fallbacks -- so already-stored journeys read right without a rebuild. Within a run of events sharing one `t`, queue events move first; a stable partition, nothing else moves.
QF-2 | script-10-escalations.html, styles.html | One action row on a worklist card: Start (now the solid button) first, Edit (now also data-admin-only) and Move as outline buttons, then the admin verbs pushed right via the new `escAdminActionsHtml_` (lifted out of the card builder; resolved / rejected / removed cards keep a separate right-aligned row). A title on every action button (Start: "Mark this escalation as In progress -- someone is working on it"; Edit, Reject, Reopen, Save resolution, Save comment only). No ellipsis on Move or Link department (inline-form toggles); Delete / Remove / Restore keep it. The "Resolve / comment" disclosure now renders after the move / link forms, so those open right under the row. Root cause: `.btn-ghost` had NO CSS rule; it is now styled under `.esc-card` only.
QF-3 | styles.html | The panel's `.ap` gets a 3px accent left border (continuing the open row's rail), a 1px accent right border and a faint accent tint; the open row's last cell gets the matching right edge.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 2714 pass / 0 fail (+4); lint:gas clean; INV-16 guard clean; module-deps regenerated (+1 symbol) and clean; claude-md-split 11/11; ci:ui CIUI_RESULT. Bites: QF-1 5/5 (capture call, same-second grouping, both shapers, the two-copy agreement pin); QF-2 / QF-3 BITES_UI.
REGRESSION RISKS: (1) QF-1 moves a ring that legitimately belongs to an EARLIER queue behind a second queue that starts in the same second (an overflow at the exact second) -- cosmetic, and rarer than the case fixed. (2) The rule lives in two projects; caller-lookup.test.js pins that the copies agree. (3) QF-2 changes the escalation card DOM order (row, forms, then resolve); the drivers select by class, and the delegated handlers are unchanged. Edit is now hidden in View-as-Manager like the other admin buttons. (4) `.btn-ghost` stays unstyled outside the escalation card (the coaching Dismissed button, the tour's Skip / Back) -- left as is, noted below.
INVARIANTS AT RISK: None -- QF-1 reorders journey events only (no count, disposition, wait or time moves; the journey-end / queue-wait SQL reads times, not order); QF-2 / QF-3 are client-only; no new public endpoint, no write path.
NET SCORE: 3 − 1 = 2 (all three fire today; new failure mode: QF-1's same-second overflow reorder, cosmetic)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (QF-1's display fix, QF-2, QF-3) and cdr-import (QF-1 at capture) | BLOCKS DEPLOY: N
- Walk S38's QF-1 step, S45's QF-2 step, S56's QF-3 step | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy
Deploy: CDR Import: `cd apps-script/cdr-import && clasp push -f`

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- `.btn-ghost` is unstyled outside the escalation card: the coaching worklist's Dismissed button (script-7-admin) and the tour's Skip / Back (script-10) still render solid. A global rule would fix them; left out of scope.
- The owner's remaining plan items: #1 / #3 read-only diagnostics (next), the #5 + #6 callbacks mock, then #1(b) / #3(b,c).

DOCUMENTATION UPDATES NEEDED:
- None (per-call-capture.md, client-ui-conventions.md, fix-history QF-1..3, tests/README, S38 / S45 / S56 updated in this change)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
