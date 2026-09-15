---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented:
- 6a | Daily Call Queue Report: IN-APP section ordering becomes own-dept-pinned
  then worst-first (the email's comparator), shared by the table AND the CSV;
  the stale "worst-first is EMAIL-ONLY (owner ruling)" header comment updated;
  ride-along fix to the email's offender-list sort priority.
- 6b | Overview trend chart: new "Answered calls" metric (per-dept answered
  COUNT overlay), shipped on both the 90-day blob and the separately-cached
  YTD payload, with both cache prefixes bumped.

Files modified:
- apps-script/department-dashboard/CompanyOverview.gs
- apps-script/department-dashboard/script-3-overview.html
- apps-script/department-dashboard/dashboard.html
- apps-script/department-dashboard/script-11-qcd-boot.html
- apps-script/department-dashboard/QueueReportEmail.gs
- apps-script/department-dashboard/OrphanFix.gs            (cache-version mention)
- apps-script/department-dashboard/DeptConfig.gs           (cache-version mention)
- tests/unit/overview-chart-answered.test.js               (NEW)
- tests/unit/qcd-alldept-order.test.js                     (NEW)
- tests/README.md, CLAUDE.md, docs/invariants.md, docs/architecture.md,
  docs/known-issues.md, docs/conventions.md, docs/operator-state.md,
  docs/client-ui-conventions.md, docs/next-steps.md

CHANGES:

6b | CompanyOverview.gs | `ovDeptChartSeries_` gained a `trendAnswered` series
  (per-day answered COUNT) beside the existing rate — read from the SAME
  per-day {rung,answered} map, so no extra scan. It follows that function's
  null convention: a day with NO DQE rows is null so the line breaks at a
  weekday gap, while a day that has rows and answered nothing is a real 0.
  The series is shipped twice, because the chart has TWO payloads: the 90-day
  Overview blob as `trendChartAnswered`, and the on-demand YTD fetch
  (`getOverviewChartTrend`) as `trendAnswered`. That second payload is cached
  under its OWN prefix, so BOTH were bumped — `companyOverview:v21`→`v22` and
  `overviewChartYtd:v1`→`v2`. Bumping only the blob would have served a warmed
  YTD payload with no answered series for its TTL: the discovery that made this
  more than the single bump the plan called for.

6b | script-3-overview.html + dashboard.html | The range slice normalizes
  `trendChartAnswered` → `trendAnswered` alongside the other three series; an
  `answeredCalls` entry joins `OV_CHART_METRICS_` (count unit, no baseline,
  a "(rings)" header qualifier); a fourth `data-metric` tab button sits after
  "% Answered". The tab wiring is already generic over the registry, so no
  handler changed.

6a | script-11-qcd-boot.html | New `qcdAllDeptSections_(depts, myDept)` — one
  pure helper returning `{topLevel, childrenOf, mySection}`. It builds the
  parent/child grouping both callers used to build separately, then orders
  top-level sections: the viewer's own section pinned first, then abandoned %
  DESC, then RANGE violations DESC, then dept name. The first two sort keys
  are the email's comparator verbatim, over the same unit (parent + nested
  children, summed, via the existing `qcdAllDeptSectionTotal_`). The name
  tiebreak is the web's own addition, so the order does not depend on the
  payload's ordering; the email reaches the same result via a stable sort over
  an alphabetical server list. `qcdViewerDept_()` centralizes the viewer-dept
  read (still `USER.department`, deliberately not the view-as preview dept —
  unchanged from the pre-6a float). Client-side by design: the server payload
  stays alphabetical, so no `qcdAll:` cache bump and a warmed blob reorders on
  the next render. Rows WITHIN a section are untouched.

6a | script-11-qcd-boot.html (CSV) | `qcdAllDeptCsv_` now orders through the
  same helper. It previously rebuilt its own grouping from `data.depts` and
  ignored even the pre-6a viewer float, so a downloaded file disagreed with the
  screen it came from. That reconciliation is the part a user would actually
  have noticed.

6a | QueueReportEmail.gs | The header comment claiming worst-first is EMAIL-ONLY
  now records the 2026-09-14 reversal and points at the web helper, noting the
  email itself is unchanged (it has no viewer to pin for). Ride-along: the
  alert/preheader offender list sorted violations-then-pct, the REVERSE of the
  priority its own dept table uses, so the alert line could name a different
  "worst" queue than the table below it ranked first. Now pct-then-violations.

TEST RESULTS: passed. `TZ=America/Chicago npm run ci` — 1389/1389, INV-16 guard
clean. Two new suites (23 tests) are inside that run:
  - overview-chart-answered.test.js (11): the series' null-vs-real-zero
    convention against the real `ovDeptChartSeries_` via loadGas, plus source
    pins tying the two payloads, the two cache prefixes, the range slice, the
    registry entry and the tab button to one name.
  - qcd-alldept-order.test.js (12): the comparator and the pin against the
    lifted-out pure helper (the date-presets / window-clamp technique), a
    TRIPWIRE that both call sites order through it and neither rebuilds its own
    grouping, and a cross-file pin on the email's two comparators.
MUTATION-CHECKED, 13 mutations, every one caught:
  6a — viewer pin dropped (2 fail), comparator priority swapped (3), name
  tiebreak dropped (1), children not summed into the section (1), CSV stops
  sharing the helper (1), offender sort reverted (1).
  6b — absent day draws 0 (2), real zero becomes a gap (2), wrong field/rung
  (4), YTD prefix not bumped (1), YTD payload drops the field (1), range slice
  dropped (1), tab key drifts from the registry (2).

`npm run ci:ui` CANNOT RUN HERE — playwright is not installed in this
environment, and the gate skips cleanly (exit 0) rather than failing, so its
green is not evidence. Both items touch client fragments, so reasoning about
the rendered gate is required rather than optional:
  - What the gate WOULD cover and why it should stay green: drive-smoke's
    all-dept-report assertions are the tally-monotonicity property (it sorts
    rows by call volume before checking, so section ORDER cannot affect it),
    exactly-one legend / zero per-dept notes (order-independent), and
    `tr.qcd-expandable` count > 0. drive-f13's keyboard walk enumerates
    `#qcd-alldept-body tr.qcd-expandable` — also order-independent. The
    Overview chart renders the `pct` metric by default on a fresh profile, so
    the blank-canvas check is on an unchanged path.
  - The real residual risks are the two the gate is FOR, and neither is
    reachable from `node --test`: (1) a throw inside the new helper would blank
    the whole all-dept table — mitigated by `node --check` of the ASSEMBLED
    client in html-include-structure (passing) and by the helper being pure
    with null-guarded inputs, but a live click is the only proof; (2) the
    fourth tab button could overflow the metric strip on a narrow viewport —
    `.ir-chart-tabs` is `display:flex; flex-wrap: wrap`, so it wraps rather
    than overflowing, which is what drive-smoke's horizontal-overflow check
    measures. RUN `npm run ci:ui` BEFORE DEPLOY (deploy.sh gates on it).

REGRESSION RISKS:
- `qcdAllDeptRender_`'s `mySection` is now produced by the helper rather than
  computed inline. Its one downstream consumer — the auto-expand of the
  viewer's own section — reads the same value for the same inputs, and the
  suite pins `mySection` for the own-dept, child-dept and absent-dept cases.
- The CSV's row CONTENT is byte-identical; only section ORDER changed (and it
  now matches the screen). A consumer diffing two exports of the same day
  across this deploy will see reordered sections. Deliberate, per the owner's
  ruling; the totals rows are unchanged.
- The email's offender-sort change alters which queue is NAMED FIRST in the
  alert line and preheader when several are over the standard. The SET of
  offenders is unchanged. `queue-report.test.js` passes unchanged, which is
  the honest reading: it did not pin that priority, so nothing contradicted
  the old order either.
- Two cache bumps mean one cold recompute of the Overview blob and the YTD
  chart payload per (dept, window) after deploy. Expected and bounded.
- No server aggregation rule moved: `trendAnswered` is a new field, the three
  existing series are pinned unchanged, and 6a is entirely client-side.

INVARIANTS AT RISK: None violated.
- INV-30 (versioned cache prefixes) is the one in play and was HONORED twice —
  `companyOverview:v22` and `overviewChartYtd:v2` — with every mention across
  the code and the eight cache-version-sync DOC_FILES updated; that suite
  passes, and it is what caught two stale markdown TABLE rows (known-issues,
  conventions) that a grep for the prefix string alone would have missed.
- INV-40 (the "X of Y agents" 30-day denominator) is untouched: the answered
  series rides the 90-day CHART window, which is deliberately separate from
  the 30-day sparkline series.
- INV-42 (chart colors through THEME) unaffected — no new color plumbing.
- INV-51 / INV-50 (QCD surfaces) unaffected — 6a reorders presentation only
  and reads figures through the existing `qcdAllDeptSectionTotal_`.

NET SCORE: production fixes 2 − new failure modes 0 = 2
- 6a: (a) would it have fired this month? YES — the CSV/screen disagreement is
  live on every export the owner takes, and the email's offender line already
  disagrees with its own table whenever two queues are over the standard.
  (b) new failure mode? NO. (The worst-first reorder itself is a preference
  change, not a fix; the CSV reconciliation and the offender sort are the
  fixes counted here.)
- 6b: (a) NO — this is a new capability, not a bug. (b) new failure mode? NO.

OPERATOR ACTIONS / DEPLOY:
- None. No Script Property, sheet, trigger or migration. | BLOCKS DEPLOY: N
Deploy: Department Dashboard — `scripts/deploy.sh .` from the repo root (it
gates on `npm run ci` AND `npm run ci:ui`, so run it somewhere playwright is
installed; a bare `clasp push -f` would bypass the rendered gate AND ship
unstamped, per E3).

FOLLOW-ON ITEMS:
- 6c (Outbound report — release, not build) and 6d (agent-day interaction view)
  remain queued in docs/next-steps.md, unchanged.
- The owner's open question "how can the Outbound report be improved?" is still
  owed as a written answer; it is a design discussion, not code, and was
  deliberately left out of this implementation scope.
- Noticed, NOT fixed (out of scope): `qcdAllDeptPrint_` clones `#qcd-alldept-body`,
  so the print output inherits the new order for free — no change needed, noted
  only so a future reader does not go looking for a third ordering site.

DOCUMENTATION UPDATES NEEDED: done in this commit.
- docs/client-ui-conventions.md: a new bullet for the 6a in-app section order
  (including the reversed ruling and the shared-helper tripwire), and the
  Overview trend-chart bullet now documents `OV_CHART_METRICS_` as a registry
  and names all four metrics with the rings-vs-queue reconciliation caveat.
- INV-30 in docs/invariants.md carries the v22 and overviewChartYtd:v2 history;
  the version tables in docs/known-issues.md and docs/conventions.md, the
  routing table in docs/architecture.md, and the passing mentions in CLAUDE.md,
  docs/operator-state.md, OrphanFix.gs and DeptConfig.gs are all updated.
- tests/README.md: both new suites registered in the coverage map
  (claude-md-split enforces completeness).
- docs/next-steps.md: 6a and 6b marked DONE with a status line on Batch 6.
---END BROAD SCAN IMPLEMENTATION SUMMARY---
