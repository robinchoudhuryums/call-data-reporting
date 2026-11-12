---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: None (E1 holds no finding; it is one completeness gap)
New capabilities (G/ST): G1 (EXC-3) — exception days now leave the callback figures (queue and direct lines, with their drill lists), the abandon heatmap and its cell lists, and the insurer daily drill; the five report emails say so in their own text. team-tools (the other half of G1) lives in a separate repo and is not touched.
Files modified: apps-script/department-dashboard/OutboundReport.gs, InboundReport.gs, Util.gs, EmailKit.gs, DeptSummaryEmail.gs, InsightsReport.gs, IndividualReport.gs, script-1-core.html, script-3-overview.html, script-9-inbound-direct.html; tests/unit/exception-days-rest.test.js (new), heatmap-fallback.test.js, outbound-fallback.test.js; tools/ui-harness/build-harness.js, drive-callbacks.js, README.md; tests/README.md; CLAUDE.md; docs/operator-state.md, client-ui-conventions.md, fix-history.md, next-steps.md, regression-scenarios.md, invariants.md, conventions.md, known-issues.md, architecture.md, per-call-capture.md, module-dependencies.md

CHANGES:
G1 | OutboundReport.gs | One rule, the Inbound report's: a view leaves out an abandon dated on an exception day for that view (department view: its own days and all-department days; company view: all-department days only). The raw counts (cbCounts, dlCounts) drop the day in the SQL and in the sheet twin. An episode leaves when its FIRST attempt fell on such a day, applied after the engine (obEpWithoutExceptions_), in the report, the direct-line figures, the repeat-callers list and both drill lists. `callback.exceptionDays` / `meta.exceptionDays` name the days, absent when there are none.
G1 | InboundReport.gs | The heatmap grid (SQL + sheet twin) and a cell's drill list take the same clause; a one-day range list keeps every call. The insurer daily drill takes it too. Both carry meta.exceptionDays.
G1 | Util.gs, EmailKit.gs, DeptSummaryEmail.gs, InboundReport.gs, InsightsReport.gs, IndividualReport.gs, OutboundReport.gs | exceptionNoteText_ (the screen note's sentence, server side) and ekExceptionNoteRow_; the My Department, Inbound, Insights and Outbound emails and an agent's Individual Report copy carry it. The Outbound email says the callbacks exclude the day and the activity table does not.
G1 | script-1-core.html, script-3-overview.html, script-9-inbound-direct.html | excPartHtml_ / excPartText_: a note for a section with its own window ("These callback figures exclude it."), on the callback summary, three drill lists, the direct-lines note and the Overview's Callbacks by department. The heatmap, its cell drill and the insurer drill pass the admin include switch.
G1 | InboundReport.gs, OutboundReport.gs + docs | Cache prefixes bumped so cached reports re-key on deploy: inbound v17, inboundHeatmap v5, outboundReport v12, outboundDirect v6.
G1 | heatmap-fallback.test.js, outbound-fallback.test.js | These suites asserted "nothing was cached" / "the workbook was not opened" by counting every cache entry and every open. The report paths now read the exception-day list (its own 5-minute cache entry, same workbook), so they count the report's own entries and export-tab reads.

TEST RESULTS: passed — `TZ=America/Chicago node --test` 3044 pass, 0 fail, 1 skipped (11 new tests); `npm run lint:gas` clean; module-deps and the INV-16 guard clean; `npm run ci:ui` all stages passed (one new rendered check in drive-callbacks.js); 11 bite-checks, each named test went red on its mutation.
REGRESSION RISKS: (1) Callback figures change on any window holding an exception day (09/21 is one today): fewer callers, different rates. Intended, and each section says so. (2) In the company Callbacks by department table, a one-department exception day stays in that department's row, so the row differs from the department's own view for such a window (the company view keeps one-department days, as the Inbound report does). (3) The callback sections do not follow the admin "Include them" switch; their note says the day is left out even while the page note says INCLUDED. (4) The callbacks alert reason reads the same event SQL; only its unused counts changed.
INVARIANTS AT RISK: INV-30 — honoured (four prefixes bumped, docs and cache-version-sync in step). INV-01 — untouched (no new write). INV-39 — the new callback field rides inside `callback`, which is already stripped for non-admins while the outbound gate stands.
NET SCORE: 0 − 1 = −1 (G1 is new capability, so no production fix is claimed; the one new failure mode is risk 2, documented in Operator State #81)

OPERATOR ACTIONS / DEPLOY:
- Deploy the dashboard; then run `runLiveSmoke` | BLOCKS DEPLOY: N
- Re-run `runOutboundVettingCheck` over a window that holds 09/21 and confirm the abandon parity reads clean (Operator State #63) | BLOCKS DEPLOY: N
- Walk the EXC-3 step of regression scenario S68 | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `clasp push -f` from repo root, then Apps Script editor → Deploy → Manage deployments → pencil → Version: New version → Deploy (or `scripts/deploy.sh .`)

(Not complete in production until blocking operator actions are done AND
the deploy step is confirmed.)

FOLLOW-ON ITEMS:
- The company Callbacks by department table could apply each row's own department days (risk 2); the anonymous counts per row carry no date, so it needs a count by date first.
- The callback sections could follow the admin include switch (outboundResolveRequest_ does not read it).
- The callbacks alert reason's miss list still includes callers who hung up on an exception day.
- The admin-only Outbound report's activity table still counts exception days.
- team-tools' reads of the workbook (the rest of G1) — a change in the team-tools repo.

DOCUMENTATION UPDATES NEEDED:
- None — Operator State #81, the CLAUDE.md index line, client-ui-conventions, fix-history (EXC-3), next-steps, S68, INV-30 and tests/README were updated in this change.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
