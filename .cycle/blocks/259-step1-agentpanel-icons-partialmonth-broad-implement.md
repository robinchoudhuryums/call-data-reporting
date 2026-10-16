---BROAD SCAN IMPLEMENTATION SUMMARY---
Findings implemented: Owner plan "Step 1" (2026-10-16, post-cycle-259 testing round; not scan findings):
  - 1a Agent panel day strip runs oldest-to-newest, opened and scrolled to the newest day
  - 4  Insights brief status tiers render as icons (thumbs-up / exclamation / flag / circle-with-dash), word kept for screen readers
  - 2  Insights trend charts mark a partly covered month on COUNT metrics (option A: dashed, hollow point, "(to date)", pace in tooltip)
New capabilities (G/ST): None (owner-requested UX changes)
Files modified:
  apps-script/department-dashboard/script-10-escalations.html
  apps-script/department-dashboard/script-8-insights.html
  apps-script/department-dashboard/styles.html
  tests/unit/insights-partial-month.test.js (new)
  tests/README.md
  tools/ui-harness/drive-agentpanel.js
  tools/ui-harness/drive-smoke.js
  docs/client-ui-conventions.md, docs/per-call-capture.md, docs/regression-scenarios.md

CHANGES:
1a | script-10-escalations.html | apStripHtml_ draws strip.days reversed (server still sends the 31 most recent, newest first; days[0] stays the opening day); new apScrollStripToSelected_ called from apRenderStrip_ and apReattach_ (moving the panel node resets its scroll); arrows "Earlier days" / "Later days"; note "(oldest first)".
1a | drive-agentpanel.js | asserts ascending dates and that the selected newest box is the last one and inside the strip's visible area.
4  | script-8-insights.html, styles.html | INS_BRIEF_WORD_ -> On track / Watch / Needs attention / No signal; insBriefTierIconHtml_ renders an aria-hidden inline SVG + .sr-only word (+ title) for the top line and every row; .ins-brief-sev is an icon slot.
4  | drive-smoke.js | the admin brief check requires an svg.ins-brief-ico and a non-empty .sr-only word on every row.
2  | script-8-insights.html | PURE insTrendPartialMonths_ (workday span per partial first/last month, cut at the latest data date, holiday-aware via workingDaysBetween_), insTrendPace_, insPartialForData_, insPartialChartBits_ (segment borderDash, hollow point, tick suffix, tooltip note). Wired into insRenderCardsChartTrend_ (non-% metrics), the team monthly trend (answered / missed / volume; not %, not talk time, not daily) and the queue monthly trend (Total calls / Violations, only when its months line up with the team trend). Labels/data untouched (the point drill parses labels).
2  | tests/unit/insights-partial-month.test.js | 11 tests: spans, holidays, data-end cut, mid-month first month, single month, empty/bad input, pace, chart bits, wiring pins.

TEST RESULTS: passed -- node --test 2539 tests, 2538 pass, 0 fail, 1 skipped; lint:gas clean; INV-16 guard clean; module-deps --check clean; npm run ci:ui EXIT 0, 554 PASS / 0 FAIL (incl. the new agent-panel order + visibility checks and the icon-row check). Bites: 5/5 unit bites land (whole-month boundary, data-end cut, pace, wiring, dash); rendered bite (strip reversal removed) fails both new drive-agentpanel checks, restored 28/28.
REGRESSION RISKS:
  - Insights payloads cached before deploy carry everything needed (months, trendStart/End are long-standing), so no cache bump; the marking appears immediately.
  - The partial month's TOOLTIP pace uses the client's holiday list (__COMPANY_HOLIDAYS__), the same one the INV-35 hint uses.
  - Queue chart marking is skipped (not mis-placed) if its month list ever differs in length from the team trend.
  - Strip scroll: apScrollStripToSelected_ is a no-op when the panel or strip is absent.
INVARIANTS AT RISK: None. INV-29 (trend window) unchanged -- only the drawing; INV-41/42 (datalabels, THEME colours) -- new colours come from THEME.*; INV-30 no cache key or payload change.
NET SCORE: 0 production fixes - 0 new failure modes = 0 (owner-requested UX changes, not defects)

OPERATOR ACTIONS / DEPLOY:
- None | BLOCKS DEPLOY: N
Deploy: Department Dashboard: `scripts/deploy.sh .` (or `clasp push -f` from repo root, then Deploy -> Manage deployments -> New version)

FOLLOW-ON ITEMS:
- The Individual Report's monthly trend has the same partial-month shape on its count views; not in Step 1's scope (Insights only).
- The rest of the owner plan: Step 2 (6 Overview default highlight, 1b caller/callee labels + callback link), Step 3 (brief accordion + inbound/outbound together + preloading), Step 4 (day bars, option B), Step 5 (Notifications page, coaching release prep, two new alert reasons -- all admin-only).

DOCUMENTATION UPDATES NEEDED:
- None beyond this commit (client-ui-conventions brief + agent panel entries, per-call-capture, S56/S61 steps, tests/README map).
---END BROAD SCAN IMPLEMENTATION SUMMARY---
