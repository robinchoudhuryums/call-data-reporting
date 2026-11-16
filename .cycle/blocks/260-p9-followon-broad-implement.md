---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (three follow-on items from the P9 block, all polish or instrumentation; "follow-on items" was read as the P9 summary's list)
New capabilities (G/ST):
- P9-F1 -- the suggestion read reports how long it took (payload, status line, execution log), so whether it needs narrowing becomes a measured question.
- P9-F4 -- the status line says "Nothing left to look at" once every suggestion found has been dealt with, apart from "Nothing stands out".
- P9-F5 -- each suggestion row stays on one line (the date wrapped onto three).
Files modified:
  apps-script/department-dashboard/PartialDays.gs, script-7-admin.html, styles.html
  tests/unit/partial-day-suggestions.test.js
  tools/ui-harness/drive-admin.js, README.md
  docs/operator-state.md, docs/client-ui-conventions.md, docs/regression-scenarios.md, docs/module-dependencies.md

CHANGES:
P9-F1 | PartialDays.gs, script-7-admin.html | `getPartialDaySuggestions` times the database read and returns `readMs` (a failed read is timed too) and logs it; the line under the list ends "read in 12 s" / "read in under a second".
P9-F4 | script-7-admin.html | `pdSuggestSummary_` tells "nothing was found" from "everything found has been marked or reviewed".
P9-F5 | script-7-admin.html, styles.html | Suggestion cells are one line each; the date cell shows the weekday form with the full date as its title and the row's `data-pd-date`. On a phone the table is already its own sideways scroller (the existing rule for modal tables), so the dialog does not scroll sideways.

NOT implemented, with the reason:
- A sheet fallback for the suggestions: looked at and declined. On the `Inbound Calls` tab the agent names exist only inside the heavy call-path column (tens of megabytes for 90 days in one run), and what could be read cheaply -- outbound calls and the first agent rung -- sees only a slice of each day and would suggest partial days that were not. Recorded in Operator State #94.
- Narrowing the read: not done blind. One way to narrow (by the department's queues) changes the result; the other (a name pre-filter) may well be slower than the read it guards; and there is no production timing. P9-F1 gets the timing first.
- One-click / "mark all shown": needs the owner to say it is wanted (it turns "the admin confirms each day" into a bulk write from a rule of thumb).
- Crediting an agent's own vs-prior figures: needs the owner's rule -- it would change every vs-prior figure in two reports, and P8's approval covered team comparisons only.
- The CSR team app's matching change: a separate repository.

TEST RESULTS: passed -- `TZ=America/Chicago node --test` 3,138 pass / 0 fail (the suggestions suite extended in place); `npm run lint:gas` clean; the module-map check clean after a regenerate; `npm run ci:ui` all 18 driver runs passed, drive-admin 247 / 247 with two new rendered checks (one-line rows with the full date as the cell's title; the table its own sideways scroller at 390 px while the dialog is not). One correction on the way: a scroll wrapper I added around the table was redundant -- the existing rule for modal tables already makes it its own scroller -- so it was removed and the check points at the table. Bite-checks: 2 of 2 bite (the read is timed; nothing-left vs nothing-found).
REGRESSION RISKS: None of note. The payload gains one field (`readMs`); the suggestions' row markup changed (the driver reads `data-pd-date` now); no server rule changed.
INVARIANTS AT RISK: None.
NET SCORE: 0 production fixes − 0 new failure modes = 0

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard (push + new version). | BLOCKS DEPLOY: N
- Press "Find likely partial days" once for the largest department and read the "read in N s" at the end of the line under the list; bring that number back if it is large or the read fails. | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- Decide on one-click / mark-all for suggestions (owner).
- Decide whether an agent's own vs-prior figures should be per credited day (owner; changes every vs-prior figure in the Individual Report and Insights).
- Narrow the suggestion read once its production timing is known, if it needs it.
- Still open from P8, and not in the P9 list this batch worked from: the % Ans bar marker on Insights cards uses the department rate while the count bars use the manager-excluded team; an excluded manager still gets a team chip and a bar in the Gap vs team chart.
- team-tools' matching change (Operator State #94).

DOCUMENTATION UPDATES NEEDED:
- None -- written in this session.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
