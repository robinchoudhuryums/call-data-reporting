---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F38 (CCX-1): every escalation mutation wiped unsaved text on every card
- F72 (CCX-2): deep-link landings loaded the dept page two or three times over
- F39 (CCX-3): Refresh left five newer section stores on their pre-Refresh answer
- F42 (CCX-4): the day quick view kept a partly-failed day, with no Retry
- F45 (CCX-5): four small feedback gaps (blank Team Direct Calls card, reasonless activity error, double-sent exception-day Remove, agent Home error with no Retry)
- F41 (CCX-6): a failed Callbacks load was held for the whole window
- F44 (CCX-7): the Health page's backup probe had an empty failure handler
- F82 (CCX-8): mangled link dates stranded Insights on its form; inert group rows showed a pointer
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/script-2-chrome.html, script-4-nav.html, script-5-dept.html, script-7-admin.html, script-8-insights.html, script-9-inbound-direct.html, script-10-escalations.html, styles.html, agentApp.html
- tests/unit/client-reloads.test.js (new), client-correctness.test.js, client-dead-ends.test.js, client-lifecycle.test.js
- tools/ui-harness/build-harness.js, drive-smoke.js, drive-admin.js, drive-deptoutbound.js, README.md
- CLAUDE.md, docs/client-ui-conventions.md, docs/fix-history.md, docs/next-steps.md, docs/regression-scenarios.md, tests/README.md

CHANGES:
F38 / CCX-1 | script-10-escalations.html | escLoad_ captures the six draft textareas before it empties the list and restores them after the render (the form re-opened, Save re-armed through the list's own input handler). Each saving action blanks the fields it saved first, so they are not carried. A superseded load keeps the drafts; a card that left the list takes its drafts with it.
F72 / CCX-2 | script-2-chrome.html, script-4-nav.html, script-5-dept.html, script-8-insights.html | A link that lands on the dept page waits for the boot latest-date read (or 10 s), writes its department and window to the dept controls before the page swap, and the boot skips its own refresh while that load is out. The page-route path no longer refreshes on top of setPage's load, the /dept link refreshes only when it moved the department, and the Insights roster call is sent once per (dept, window) in flight. A user who navigates while the dates are being read is not pulled back to the link. Harness: 17 -> 10 requests (manager Insights link), 13 -> 10 (/dept), 18 -> 10 (/report/missed), 22 -> 16 (admin Insights link), none sent twice.
F39 / CCX-3 | script-5-dept.html, script-2-chrome.html, script-10-escalations.html | The Refresh button drops Team Direct Calls, the Outbound summary section, Callbacks, Direct lines and the agent panel's held strips and days. Held answers and held errors only; a request already out is left to land. Run from the button's click, not from every refresh().
F42 / CCX-4 | script-5-dept.html | A day whose reply has a failed part is served to the open pop-up but not kept; the error note carries a Retry.
F45 / CCX-5 | script-5-dept.html, script-10-escalations.html, script-7-admin.html, agentApp.html | A null Team Direct Calls reply becomes an error with its Retry; the escalation activity error shows its reason; an exception-day Remove takes a per-date in-flight guard; the agent app's first-load error has a Retry.
F41 / CCX-6 | script-8-insights.html | The Callbacks state line carries a Retry on a failed load and on an "unavailable right now" reply; it clears the held answer and asks again.
F44 / CCX-7 | script-9-inbound-direct.html | A failed (or empty) backup-status probe shows the backup section with the reason.
F82 / CCX-8 | script-4-nav.html, styles.html | A link's from/to (and pfrom/pto) pair is written only when both are real dates in order; the inert outbound / direct group rows lose the collapse toggle's pointer and hover.

TEST RESULTS: passed -- 2995 pass, 0 fail, 1 skipped (pre-existing) under TZ=America/Chicago; lint:gas clean; module-deps --check clean; INV-16 guard in sync; ci:ui all stages passed. 19 new unit tests plus rendered checks in three drivers (deep links in drive-smoke for both roles, escalation drafts in drive-admin, Refresh re-reads in drive-deptoutbound). Four existing source pins were updated on purpose (they pinned the old boot refresh, the old /dept apply and the old render-then-focus order). 17 bite checks, all bite (one new pin did not bite at first and was tightened).

REGRESSION RISKS:
- CCX-2: a link to My Department, Insights, Missed or Outbound now shows the Overview skeleton until the latest-date read answers, then switches. A slow read delays the landing by up to 10 seconds before the link gives up waiting.
- CCX-2: the harness ordering was reproduced, but production ordering was not observed (V6). If production answers the dates before the link arrives, the link dispatches at once and behaves as before, minus the duplicates.
- CCX-3: the first version cleared on every refresh() and sent Team Direct Calls twice after a typed date plus Refresh; drive-deptoutbound.js caught it. The shipped version clears from the button only and never while a request is out.
- CCX-1: restored text is written back only into an empty field of the same class on the same card id; a card whose form is no longer rendered loses its draft.

INVARIANTS AT RISK: None. No server file changed. INV-37 (setPage owns the page swap; refresh() writes the title only on the dept page) and INV-43 (the From/To default snaps to the latest DQE date) hold: the snap now happens before a deep link is dispatched.

NET SCORE: 2 − 1 = 1
(CCX-1 and CCX-2 fire on ordinary use: any action on the escalations list while text is typed, and every digest-link click. CCX-2 adds one new behaviour to watch, the wait before a dept-page link lands. The other six need a failed request or a hand-mangled link.)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (client files only) | BLOCKS DEPLOY: N
- After the deploy, open a digest "See the full breakdown" link in a fresh tab and count the Apps Script executions (V6): expect about 8-10 for a manager, about 15 for an admin, none repeated | BLOCKS DEPLOY: N
- Walk Regression Scenario S71 | BLOCKS DEPLOY: N
Deploy:
- Department Dashboard: `clasp push -f` from repo root, then Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The boot still fetches the Overview payload for a visitor whose link takes them straight to another page.
- A date typed and then Refresh pressed still sends the summary request twice (the debounced edit plus the click); this predates the batch.
- The Overview's own Direct lines block (ov-dl) and the other modals' stores are outside the Refresh button's list by design; nothing drops them short of a window change.
- Drafts in the escalation create / edit form and in thread comment boxes are not covered by CCX-1 (they are not re-rendered by the list reload).

DOCUMENTATION UPDATES NEEDED:
- None (docs/client-ui-conventions.md router section and "What survives a reload", fix-history CCX-1..8, next-steps, Regression Scenario S71 with its CLAUDE.md index line, tests/README.md and the harness README were updated in the batch)
---END BROAD SCAN IMPLEMENTATION SUMMARY---
