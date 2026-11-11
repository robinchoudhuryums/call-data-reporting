---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- F70 (KBF-1): the shared focus trap omitted fold headers and counted controls inside closed folds (Tab walked out of Help and Direct Calls)
- F71 (KBF-2): eleven modals returned focus to a hidden menu item on close, leaving it on <body>
- F79 (KBF-6): some metric explanations opened on hover only
- F74 (KBF-3): the missed-calls half-hour drill had no Tab path
- F75 (KBF-4): the two edit popovers neither took focus on open nor returned it on Close
- F77 (KBF-5): four chip groups kept the selected state in a class only
New capabilities (G/ST): None
Files modified:
- apps-script/department-dashboard/script-1-core.html, script-2-chrome.html, script-4-nav.html, script-5-dept.html, script-6-ir.html, script-7-admin.html, script-8-insights.html, script-9-inbound-direct.html, script-10-escalations.html, script-11-qcd-boot.html, agentApp.html, dashboard.html, styles.html
- tests/unit/keyboard-focus.test.js (new)
- tools/ui-harness/drive-admin.js, drive-f13.js, drive-agent.js, README.md
- docs/client-ui-conventions.md, docs/fix-history.md, docs/next-steps.md, docs/regression-scenarios.md, tests/README.md

CHANGES:
F70 / KBF-1 | script-1-core.html | The fix itself (fold headers are tab stops; nothing inside a closed fold is) landed one commit earlier with DCA-7, which hit the same leak in Outlier Fix. This batch moved the list into one shared focusablesIn_ (popovers read it too) and added the missing proof: Help walked for 40 Tabs with its topic folds closed.
F71 / KBF-2 | script-1-core.html, script-2-chrome.html, script-7-admin.html, script-9-inbound-direct.html, script-10-escalations.html, script-11-qcd-boot.html | New returnFocusTo_(opener): the opener if it is on screen, else the trigger of the header menu it lives in, else the page title. Fifteen closeModal functions call it instead of btn.focus() (the eleven menu-opened modals, plus Help, Settings, the Queue report and Caller Lookup).
F74 / KBF-3 | script-5-dept.html, dashboard.html, styles.html | One <select> in the missed-chart toolbar lists the half-hours that have rings (with the count the panel shows) and opens that half-hour; it is clipped until it has keyboard focus, so the toolbar is unchanged for a mouse user. Closing the panel from inside returns focus to the picker. The ring-time links stay tabindex=-1 (UD-4); the UD-4 comment that said the chart's bars were tabbable is corrected.
F75 / KBF-4 | script-1-core.html, script-8-insights.html, script-6-ir.html | popoverFocusIn_ focuses the asked control only when Tab could reach it, else the first control after the Close button; popoverClose_ hides the popover and returns focus to its opener only while focus is still inside it. Both edit popovers (Insights, Individual Report) use them.
F77 / KBF-5 | script-2-chrome.html, agentApp.html | The date chips, theme chips, Help topic links and the agent app's window chips write aria-pressed wherever they write their selected class.
F79 / KBF-6 | script-4-nav.html, script-9-inbound-direct.html, dashboard.html | A label the glossary tags becomes a tab stop unless it already is one, holds a control or sits inside one, so the existing on-focus tooltip can open. The Inbound reconcile hint gains the .gloss class its tooltip listens for; the queue-only abandoned heading gains a tab stop.

TEST RESULTS: passed -- 3021 pass, 0 fail, 1 skipped (pre-existing) under TZ=America/Chicago; lint:gas clean; module-deps --check clean; INV-16 guard in sync; ci:ui all stages passed. 9 new unit tests in keyboard-focus.test.js; 10 mutation (bite) checks, all red on mutation. New rendered checks: drive-admin (every modal's Escape returns focus to a visible control; Help 40-Tab walk; Help topics and theme chips pressed state; Inbound's 20 header labels take focus and open their tooltip), drive-f13 (the half-hour picker end to end; date chips; the Insights popover; no hover-only label on My Department), drive-agent (window chips). Regression Scenario S39 has the manual steps; its automated counterpart passed.

REGRESSION RISKS:
- F79 adds tab stops: every glossary-tagged label that was not already focusable (KPI labels, side-panel labels, headers of a table with no rows). A keyboard user presses Tab more times to cross a report. Chosen over leaving the explanations mouse-only; the two chips that repeat on every agent card were left out for this reason.
- F74's picker relies on :focus-visible. A browser without it drops the clipping rule and shows the picker all the time (it still works).
- F71 changes where focus lands after closing a modal for everyone, mouse users included (the next Tab now starts at the menu button, not the end of the page). No caller reads the old behaviour.
- F75: closing a popover by clicking outside it deliberately does NOT return focus (it would undo the click and scroll the page to the opener).

INVARIANTS AT RISK: None. Client-only; no payload, cache key, gate or write path changed. INV-37 (page model) and INV-41/42 (charts) untouched.

NET SCORE: 0 − 0 = 0
(a) Fired in production this month: F70 NO, F71 NO, F74 NO, F75 NO, F77 NO, F79 NO -- each reproduces on the live client for anyone using a keyboard or a screen reader, but nothing shows such a user hit them this month.
(b) New failure mode: F70 NO, F71 NO, F74 NO, F75 NO, F77 NO, F79 NO (the added tab stops are a cost, listed above, not a failure).

OPERATOR ACTIONS / DEPLOY:
- Walk S39's Batch 9 (KBF) steps by keyboard after the deploy | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The Individual Report's own close (irFocusAfterClose_) goes opener → launcher → page title and skips the Reports ▾ trigger, so an admin closing it lands on the title while Inbound / Direct land on Reports ▾. Left alone (not in F71's eleven; it never dropped focus to <body>).
- The two per-agent-card chips (.ins-trend-pill, .cr-vs-team) still explain themselves on hover only. Deliberate (two tab stops per agent); the vs-team numbers are on the chip and the trend wording is in Help. Owner's call if they should be reachable another way.
- The Inbound report's sortable headers get their Enter / Space sort only once the table has rows (srtApply_ wires on first paint). With no rows they are now focusable labels with no sort action -- harmless, noted.
- The half-hour picker is hidden until focused. If the owner would rather it always show (it also helps on a touch screen, where the bars are thin), that is one CSS rule.

DOCUMENTATION UPDATES NEEDED:
- None outstanding. Done in this batch: docs/client-ui-conventions.md (accessibility contract: two new rules + the opener and popover rules), docs/fix-history.md (KBF-1..6), docs/next-steps.md, docs/regression-scenarios.md (S39), tests/README.md, tools/ui-harness/README.md. CLAUDE.md needed no change.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
