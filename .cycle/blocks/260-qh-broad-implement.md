---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- QH1 | The Queue health chart was cramped and its table scrolled sideways: the two sat side by side in ~1,000 px beside the two sticky panels. Stacked, each at the section's full width.
New capabilities (G/ST):
- QH2 | A violation date marks its day on the queue chart (hover or keyboard focus; the "Violation dates" label marks every listed day).
- QH3 | Queues with no calls in the period fold into one row that names them, and leave the chart when they have no calls anywhere in the span shown.
- QH4 | With no view picked, the queue chart opens on Daily for a window of 45 days or less and on Monthly otherwise; a clicked view is saved as a choice.
(QH2-QH4 are owner-approved improvements from the "QH" plan of 2026-11-24, not scan findings. No scan report was involved: the plan text is in .cycle/STATE.md.)
Files modified:
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/styles.html
- apps-script/department-dashboard/script-8-insights.html
- apps-script/department-dashboard/script-4-nav.html
- tests/unit/brief-accordion.test.js
- tests/unit/client-dead-ends.test.js
- tools/ui-harness/drive-smoke.js
- docs/client-ui-conventions.md, docs/regression-scenarios.md, docs/fix-history.md, docs/next-steps.md, tests/README.md, tools/ui-harness/README.md, CLAUDE.md (one index tag, +9 bytes)

CHANGES:
QH1 | dashboard.html, styles.html | The chart card moved above the table card inside .ins-qh-cols; both are flex: 1 1 100% at every viewport (the UD-2 phone floor kept); the canvas is 240 px tall (was 260). Footnote and Help text say "above the table".
QH2 | script-8-insights.html, styles.html, script-4-nav.html | insQhMark_(queue, dates, allDates) + the inline chart plugin INS_QH_MARK_PLUGIN_ (a dashed guide at each marked x, a ring on that queue's point, a "N violation days" note on Monthly) + PURE insQhMarkPoints_. Hover / focus listeners delegated on the document (qhViolTarget): a chip marks one day, the label (.ins-viol-label, a tab stop) marks all. Calendar view: .is-viol-mark outlines the day cells. The other queues dim through the existing spotlight; a pinned queue wins. The chip's click (the Daily breakdown jump) is unchanged. The Monthly x position reads month keys back from the axis labels themselves (insTrendLabelToRange_).
QH3 | script-8-insights.html, styles.html | PURE insQhEmptyQueues_ (zero calls in the period; never all queues) + insQhEmptyLabel_ (the row names them). Empty queues' rows are still built, marked .ins-qh-empty, placed last and hidden behind one .ins-qh-empty-head row; open / closed is the class is-empty-open on the tbody. PURE insQhChartQueues_ leaves a queue off the chart only when its Total calls series for the view on screen is all zero; colours stay keyed to the full queue list.
QH4 | script-8-insights.html | PURE insQhAutoView_ (Daily at <= 45 days when a daily series exists) + insQhWindowDays_ + insQhPickedFromPrefs_. New state insQhViewPicked, saved as qhViewPicked. The view-button handler no longer early-returns on the stored view alone. A prefs blob from before QH4 with qhChartView 'monthly' is read as "no choice made"; 'daily' / 'calendar' as a choice.

TEST RESULTS: passed. TZ=America/Chicago node --test: 3,194 pass, 0 fail, 1 skip (the existing skip); 6 new tests, 3 existing pins updated for the stacked layout. npm run lint:gas: clean. module-deps --check and the INV-16 guard: clean. TZ=America/Chicago npm run ci:ui: all stages passed, 18 of 18 runs, on the final code (drive-smoke gained a fresh-page qhPass: 8 checks per role). 9 of 9 bite checks bite (scripts/bite.sh): QH1 layout, QH2 x3, QH3 x2, QH4 x3.
Regression Scenarios: S32 and S61 gained QH steps; they need the deployed app and were NOT walked here.

REGRESSION RISKS:
- A viewer who had deliberately clicked Monthly before this change gets the automatic view once (their saved Monthly cannot be told from the default). Approved in the plan; one click restores it and it is then remembered.
- With the chart above the table, a queue's row-hover highlight and a violation-date mark are off screen once the reader has scrolled down a long expanded table. Accepted in the plan; the chart is 240 px so the common case fits one view.
- The fold row's open state lives on the tbody for the session, so it carries across a department switch (FO-260-1).
- Tab order in the section is now chart controls, then table.

INVARIANTS AT RISK: None. Checked: INV-41 / INV-42 (the mark plugin takes colours from THEME.*; safeChart_ is still the only chart constructor), INV-53 / INV-39 (no payload or totals change), INV-30 (no server change, no cache version moves).

NET SCORE: 1 - 0 = 1
(QH1 YES / no new failure mode. QH2, QH3, QH4 are capabilities: NO / no new failure mode -- the one-time loss of a pre-QH4 Monthly choice is a stated, approved behaviour, listed under risks.)

OPERATOR ACTIONS / DEPLOY:
- Walk S32 (the QH1-QH4 steps) and S61 after the deploy | BLOCKS DEPLOY: N
- Data check from the plan, on live data: on the Daily view, every marked violation day should sit at or above the 4% line for its queue. Not checkable from here (the harness fixture generates violation flags independently of the percentages). By INV-50 a violation IS a day at 4.00% or more on the Total Calls source, so they should agree for dates from 2026-08; a day below the line is a data question to report (#73). | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor -> Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- FO-260-1 | script-8-insights.html: the "queues with no calls" fold row -- its open state is a class on the tbody, so it stays open across a department switch within one session | -> next audit
- FO-260-2 | script-8-insights.html: insRenderQhChart_'s partial-month marking still pairs the queue chart's month LABELS with the team trend's month KEYS by equal length alone. A probe run outside TZ=America/Chicago showed the two lists one month apart at equal length (a harness artifact; production runs in one zone). QH2's marks no longer depend on it; the partial-month marking does | -> next audit
- FO-260-3 | script-8-insights.html: the queue chart's Daily axis prints raw ISO dates ("2026-10-26"). QH4 makes Daily the default face for short windows, so this is now what most readers see first; a shorter tick ("Oct 26") is a tick-callback change (the point drill parses the label, so the label itself must stay ISO) | -> decision (owner: shorten the Daily axis ticks?)

DOCUMENTATION UPDATES NEEDED:
- None. Done in this change: docs/client-ui-conventions.md (the QH1-QH4 paragraph), docs/regression-scenarios.md (S32, S61), docs/fix-history.md (QH1-QH4 rows), docs/next-steps.md (row status), tests/README.md, tools/ui-harness/README.md, CLAUDE.md (index tag).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
