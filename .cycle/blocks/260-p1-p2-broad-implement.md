---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: P1 (quick display fixes: Call ID chip colour, "instant" ring, busy colour, duplicate date, pinned Transfer retries header, Outlier Fix "Apply selected" for Not an agent) and P2 (the agent panel's Direct calls tab) from the follow-up plan of 2026-11-13 (owner notes, not scan findings).
New capabilities (G/ST): None from the scan's expansion plan. Within P2, the Direct list's filter, sortable headers and admin Call ID are new behaviour rather than fixes.
Files modified: apps-script/department-dashboard/script-5-dept.html, script-7-admin.html, script-9-inbound-direct.html, script-10-escalations.html, styles.html; tests/unit/panel-direct-tab.test.js (new), direct-calls-capture.test.js; tools/ui-harness/build-harness.js, gen-payloads.js, drive-agentpanel.js, drive-admin.js, README.md; tests/README.md; docs/client-ui-conventions.md, fix-history.md, regression-scenarios.md

CHANGES:
P1a | script-5-dept.html, script-7-admin.html, styles.html | parentIdBadge takes a 4th argument and adds `.parent-id--neutral` for an outbound call or `opts.neutral`. It was built for abandoned timestamps and was always red; the abandoned callers are unchanged.
P1b | script-10-escalations.html | A connected outbound call that rang 0-1 s reads "instant" in the agent panel's Outbound list. An unanswered call keeps its ring time; unknown stays "–".
P1c | script-5-dept.html | The Missed Calls summary strip no longer carries "Range:"; the heading beside it has the date.
P1d | script-5-dept.html, script-9-inbound-direct.html, script-10-escalations.html, styles.html | "Missed while on another call" uses a new light yellow `.ob-seg-busy` (and `.tly.mb`) at every draw site. The soft red keeps "rang out", "ringing a person's line" and "brief ring".
P1e | styles.html | The Transfer retries case table scrolls in its own box with a pinned header row.
P1f | script-7-admin.html | Outlier Fix: an unlisted-extension row is tickable with nothing mapped, and "Apply selected" sends those names to setOrphanIgnored (chunks of 200) before any renames and roster adds. No server change.
P2a | script-10-escalations.html | "Way" is "Direction", with Incoming / Outgoing.
P2b | script-10-escalations.html, styles.html | A filter row (Direction, Outcome, with a count line) above the list and sortable headers; the choice is kept across days and tabs.
P2c | script-10-escalations.html | Admins get each direct call's id in a neutral chip with a copy button.
P2d | script-10-escalations.html, script-5-dept.html | A call the agent placed to an outside number leaves the Direct list, its tab count and the quick view's count. The summary's second headline is "N calls to colleagues" with a "+N to outside numbers — listed under Outbound calls" line; its foot is computed from the listed rows.
P2e | script-10-escalations.html, styles.html | The colleague table wraps instead of overrunning its card and its columns read Outgoing / Incoming.

TEST RESULTS: passed — `TZ=America/Chicago node --test` 3053 pass, 0 fail, 1 skipped (9 new tests in panel-direct-tab.test.js; one pinned line in direct-calls-capture.test.js updated for the new tab count); `npm run lint:gas` clean; module-deps and the INV-16 guard clean; `npm run ci:ui` all stages passed, with 7 new rendered checks in drive-agentpanel.js and 3 in drive-admin.js; 8 bite-checks, each named test went red on its mutation.
REGRESSION RISKS: (1) Outlier Fix "Select all" now also ticks unlisted-extension rows, so Select all then Apply marks them all Not an agent; the dialog states the count and the action is reversible. (2) The Direct tab's count and second headline are lower than before wherever the agent placed calls to outside numbers; the "+N" line can differ from the Outbound tab's count by a call or two because the two captures count transfers and connects differently. (3) The Transfer retries table is now a scroll box inside the modal (at most 62% of the window height). (4) Every outbound Call ID chip is neutral, including on Agent Day's cards and the Transfer retries table.
INVARIANTS AT RISK: None — client and CSS only; no server, payload or cache-key change (INV-01, INV-30, INV-39 untouched).
NET SCORE: 2 − 1 = +1 (production fixes: the red chip and the "Apply selected" bug; new failure mode: risk 1)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard | BLOCKS DEPLOY: N
- Walk the new P1 / P2 steps in regression scenarios S56, S31, S69 and S4 | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The server's direct summary still counts outside-number calls in `out.total`; the client derives the colleague figures. Moving that to the server would let the foot stop depending on the listed rows.
- The Direct Calls report modal still labels direction "IB / OB"; only the agent panel was in scope.
- Remaining batches of the follow-up plan: P3 (Transfer retries: answered, then redirected), P4 (Team Direct Calls card), P5 ("Other" department), P6 (answer-time trends), P7-P9 (partial days), P10 (Transfer retries availability), P11 (callback worklist; needs the owner's privacy decision).

DOCUMENTATION UPDATES NEEDED:
- None — docs/client-ui-conventions.md, fix-history.md, regression-scenarios.md (S56, S31, S69, S4), tests/README.md and the harness README were updated in this change.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
